// Generic background-job runner (AD-01): claim -> handler -> complete | fail (with backoff/dead).
// Service-role only (ARCH §5.3): the caller passes the admin client in; this file never builds one.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/database.types";

export type ClaimedJob = Database["public"]["Tables"]["background_jobs"]["Row"];
export type JobHandler = (job: ClaimedJob) => Promise<Json>;
export type JobHandlers = Record<string, JobHandler>;

export type RunOutcome =
  | { ran: false }
  | {
      ran: true;
      jobId: string;
      jobType: string;
      status: "succeeded" | "failed" | "dead";
      error?: string;
    };

export async function runNextJob(
  admin: SupabaseClient<Database>,
  handlers: JobHandlers,
  worker: string,
): Promise<RunOutcome> {
  const { data, error } = await admin.rpc("claim_background_job", {
    p_job_types: Object.keys(handlers),
    p_worker: worker,
  });
  if (error) throw new Error(`claim failed: ${error.message}`);
  const job = data?.[0];
  if (!job) return { ran: false };

  const handler = handlers[job.job_type];
  try {
    if (!handler) throw new Error(`no handler for ${job.job_type}`);
    const result = await handler(job);
    const { error: doneErr } = await admin.rpc("complete_background_job", {
      p_id: job.id,
      p_worker: worker,
      p_result: result,
    });
    if (doneErr) throw new Error(`complete failed: ${doneErr.message}`);
    return {
      ran: true,
      jobId: job.id,
      jobType: job.job_type,
      status: "succeeded",
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const { data: status } = await admin.rpc("fail_background_job", {
      p_id: job.id,
      p_worker: worker,
      p_error: message,
    });
    return {
      ran: true,
      jobId: job.id,
      jobType: job.job_type,
      status: status === "dead" ? "dead" : "failed",
      error: message,
    };
  }
}

/** Runs due jobs until none are left (or `max` is reached). */
export async function runDueJobs(
  admin: SupabaseClient<Database>,
  handlers: JobHandlers,
  worker: string,
  max = 25,
): Promise<RunOutcome[]> {
  const outcomes: RunOutcome[] = [];
  for (let i = 0; i < max; i++) {
    const o = await runNextJob(admin, handlers, worker);
    if (!o.ran) break;
    outcomes.push(o);
  }
  return outcomes;
}
