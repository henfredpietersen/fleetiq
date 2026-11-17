import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";

export type CleanupSummary = {
  claimed: number;
  objectsRemoved: number;
  slotsMarked: number;
  /** Paths the database offered but that belong to registered evidence — never deleted. */
  skippedRegistered: number;
};

/**
 * ARCH §6.3 — remove uploads that were never registered (AD-01 handler, job type
 * `evidence.cleanup_unregistered`). Runs with the service-role client (jobs: ARCH §5.3).
 *
 * Two-phase and retry-safe: claim_abandoned_evidence_slots() flips expired-and-unregistered slots to
 * 'abandoned' and returns them; objects are removed; only then are they marked removed. If removal
 * throws, the slots stay 'abandoned' and the next run picks them up again.
 * Registered evidence is never touched: the database excludes it, and it is re-checked here.
 */
export async function cleanupUnregisteredUploads(
  admin: SupabaseClient<Database>,
  opts: { graceMinutes: number; batchSize: number },
): Promise<CleanupSummary> {
  const { data: claimed, error } = await admin.rpc(
    "claim_abandoned_evidence_slots",
    {
      p_grace_minutes: opts.graceMinutes,
      p_limit: opts.batchSize,
    },
  );
  if (error) throw new Error(`claim failed: ${error.message}`);
  const slots = claimed ?? [];
  if (slots.length === 0) {
    return {
      claimed: 0,
      objectsRemoved: 0,
      slotsMarked: 0,
      skippedRegistered: 0,
    };
  }

  // Defence in depth: never delete an object that has an evidence row.
  const paths = slots.map((s) => s.object_path);
  const { data: registered, error: regErr } = await admin
    .from("evidence_files")
    .select("bucket, object_path")
    .in("object_path", paths);
  if (regErr) throw new Error(`registered check failed: ${regErr.message}`);
  const protectedKeys = new Set(
    (registered ?? []).map((r) => `${r.bucket}/${r.object_path}`),
  );
  const removable = slots.filter(
    (s) => !protectedKeys.has(`${s.bucket}/${s.object_path}`),
  );

  const byBucket = new Map<string, string[]>();
  for (const s of removable) {
    byBucket.set(s.bucket, [...(byBucket.get(s.bucket) ?? []), s.object_path]);
  }
  let objectsRemoved = 0;
  for (const [bucket, list] of byBucket) {
    const { data, error: rmErr } = await admin.storage
      .from(bucket)
      .remove(list);
    if (rmErr) throw new Error(`remove failed in ${bucket}: ${rmErr.message}`);
    objectsRemoved += data?.length ?? 0;
  }

  const { data: marked, error: markErr } = await admin.rpc(
    "mark_evidence_slots_object_removed",
    {
      p_ids: removable.map((s) => s.id),
    },
  );
  if (markErr) throw new Error(`mark failed: ${markErr.message}`);

  return {
    claimed: slots.length,
    objectsRemoved,
    slotsMarked: marked ?? 0,
    skippedRegistered: slots.length - removable.length,
  };
}
