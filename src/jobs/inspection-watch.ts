// Job: record each overdue inspection ONCE (DEC-43, ARCH §11, AD-01). The SQL function run_inspection_watch() does the work
// (service role only, idempotent); this file wires it to the job table. It creates NO exceptions and NO notifications:
// Phase 5 and Phase 8 read the findings. Schedule (RSAWEB, AD-01): pg_cron every 5 minutes enqueues the job, the Node worker runs it
// (see docs/CONTEXT.md "Offline and detection (Phase 4D)"). pg_cron is not in migrations.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import type { JobHandler } from "./worker.ts";

export const INSPECTION_WATCH_JOB = "inspection_watch";
export const INSPECTION_WATCH_BUCKET_MINUTES = 5;

/** Start of the 5-minute bucket `now` falls in, as an ISO minute (the key must be stable for every caller in the bucket). */
export function inspectionWatchBucket(now: Date): string {
  const ms = INSPECTION_WATCH_BUCKET_MINUTES * 60_000;
  return new Date(Math.floor(now.getTime() / ms) * ms)
    .toISOString()
    .slice(0, 16);
}

/** `inspection_watch:<company>:<5-minute bucket>`; `force` (a manual re-run) adds the exact time instead. */
export function inspectionWatchKey(
  companyId: string,
  now: Date,
  force = false,
): string {
  return force
    ? `${INSPECTION_WATCH_JOB}:${companyId}:manual:${now.toISOString()}`
    : `${INSPECTION_WATCH_JOB}:${companyId}:${inspectionWatchBucket(now)}`;
}

export async function enqueueInspectionWatch(
  admin: SupabaseClient<Database>,
  companyId: string,
  opts: { now?: Date; force?: boolean } = {},
): Promise<string> {
  const now = opts.now ?? new Date();
  const { data, error } = await admin.rpc("enqueue_background_job", {
    p_job_type: INSPECTION_WATCH_JOB,
    p_idempotency_key: inspectionWatchKey(companyId, now, opts.force),
    p_company_id: companyId,
    p_max_attempts: 3,
  });
  if (error || !data) throw new Error(`enqueue failed: ${error?.message}`);
  return data;
}

export function inspectionWatchHandler(
  admin: SupabaseClient<Database>,
  clock: () => Date = () => new Date(),
): JobHandler {
  return async (job) => {
    if (!job.company_id) throw new Error("inspection_watch needs a company");
    const { data, error } = await admin.rpc("run_inspection_watch", {
      p_company_id: job.company_id,
      p_now: clock().toISOString(),
    });
    if (error) throw new Error(`run_inspection_watch failed: ${error.message}`);
    return data;
  };
}
