// Manual job runner — no scheduler yet (pg_cron comes later, AD-01).
//   npm run job:evidence-cleanup            enqueue (once per hour) and run due jobs
//   npm run job:evidence-cleanup -- --force enqueue a fresh run now
// Needs NEXT_PUBLIC_SUPABASE_URL and the server-only elevated key variable documented in
// src/lib/supabase/admin.ts (read from .env.local if present). Jobs may use the elevated key (ARCH §5.3);
// run this on the server, never from a user request.
import { createAdminClient } from "../lib/supabase/admin.ts";
import { loadEvidenceConfig } from "../modules/evidence-storage/domain/evidence-config.ts";
import {
  enqueueEvidenceCleanup,
  evidenceCleanupHandler,
  EVIDENCE_CLEANUP_JOB,
} from "./evidence-cleanup.ts";
import { runDueJobs } from "./worker.ts";

const USAGE = "usage: run.ts evidence-cleanup [--force]";

async function main(argv: string[]): Promise<number> {
  const [command, ...flags] = argv;
  if (command !== "evidence-cleanup" || flags.some((f) => f !== "--force")) {
    console.error(USAGE);
    return command === "--help" || command === "help" ? 0 : 2;
  }
  const admin = createAdminClient();
  const config = loadEvidenceConfig();
  const jobId = await enqueueEvidenceCleanup(admin, {
    force: flags.includes("--force"),
  });
  const worker = `cli:${process.pid}`;
  const outcomes = await runDueJobs(
    admin,
    { [EVIDENCE_CLEANUP_JOB]: evidenceCleanupHandler(admin, config) },
    worker,
  );
  console.log(JSON.stringify({ enqueued: jobId, outcomes }, null, 2));
  return outcomes.some((o) => o.ran && o.status !== "succeeded") ? 1 : 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
