// Job: remove uploads that were never registered (ARCH §6.3, AD-01). Handler logic lives in the module;
// this file only wires it to the job table. The job payload cannot override the configured grace period.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import type { EvidenceConfig } from "../modules/evidence-storage/domain/evidence-config.ts";
import { cleanupUnregisteredUploads } from "../modules/evidence-storage/server/cleanup.ts";
import type { JobHandler } from "./worker.ts";

export const EVIDENCE_CLEANUP_JOB = "evidence.cleanup_unregistered";

/** Idempotent: one job per hour unless `force` (a manual re-run) adds the exact time to the key. */
export async function enqueueEvidenceCleanup(
  admin: SupabaseClient<Database>,
  opts: { now?: Date; force?: boolean } = {},
): Promise<string> {
  const now = opts.now ?? new Date();
  const key = opts.force
    ? `manual:${now.toISOString()}`
    : `hourly:${now.toISOString().slice(0, 13)}`;
  const { data, error } = await admin.rpc("enqueue_background_job", {
    p_job_type: EVIDENCE_CLEANUP_JOB,
    p_idempotency_key: key,
  });
  if (error || !data) throw new Error(`enqueue failed: ${error?.message}`);
  return data;
}

export function evidenceCleanupHandler(
  admin: SupabaseClient<Database>,
  config: EvidenceConfig,
): JobHandler {
  return async () =>
    await cleanupUnregisteredUploads(admin, {
      graceMinutes: config.cleanupGraceMinutes,
      batchSize: config.cleanupBatchSize,
    });
}
