import { describe, expect, it } from "vitest";
import { called, fakeClient } from "@/test/fake-supabase";
import { runDueJobs, runNextJob } from "./worker";

const job = (n: number) => ({
  id: `0000000${n}-0000-4000-8000-000000000000`,
  job_type: "evidence.cleanup_unregistered",
  payload: {},
});

describe("job worker (AD-01)", () => {
  it("claims, runs the handler, completes with its result", async () => {
    const f = fakeClient({
      rpc: {
        claim_background_job: () => ({ data: [job(1)] }),
        complete_background_job: () => ({ data: true }),
      },
    });
    const r = await runNextJob(
      f.client,
      { "evidence.cleanup_unregistered": async () => ({ removed: 3 }) },
      "w1",
    );
    expect(r).toMatchObject({ ran: true, status: "succeeded" });
    expect(called(f.calls, "rpc:claim_background_job")[0]!.args[0]).toEqual({
      p_job_types: ["evidence.cleanup_unregistered"],
      p_worker: "w1",
    });
    expect(
      called(f.calls, "rpc:complete_background_job")[0]!.args[0],
    ).toMatchObject({ p_worker: "w1", p_result: { removed: 3 } });
  });

  it("a throwing handler fails the job (retry/backoff is the database's job) and reports dead when exhausted", async () => {
    for (const [dbStatus, expected] of [
      ["failed", "failed"],
      ["dead", "dead"],
    ] as const) {
      const f = fakeClient({
        rpc: {
          claim_background_job: () => ({ data: [job(1)] }),
          fail_background_job: () => ({ data: dbStatus }),
        },
      });
      const r = await runNextJob(
        f.client,
        {
          "evidence.cleanup_unregistered": async () => {
            throw new Error("boom");
          },
        },
        "w1",
      );
      expect(r).toMatchObject({ ran: true, status: expected, error: "boom" });
      expect(
        called(f.calls, "rpc:fail_background_job")[0]!.args[0],
      ).toMatchObject({ p_error: "boom" });
      expect(called(f.calls, "rpc:complete_background_job")).toHaveLength(0);
    }
  });

  it("nothing due: ran=false", async () => {
    const f = fakeClient({
      rpc: { claim_background_job: () => ({ data: [] }) },
    });
    expect(await runNextJob(f.client, {}, "w1")).toEqual({ ran: false });
  });

  it("runDueJobs stops when the queue is empty or at max", async () => {
    let n = 0;
    const f = fakeClient({
      rpc: {
        claim_background_job: () => ({ data: n++ < 2 ? [job(n)] : [] }),
        complete_background_job: () => ({ data: true }),
      },
    });
    const out = await runDueJobs(
      f.client,
      { "evidence.cleanup_unregistered": async () => ({}) },
      "w1",
    );
    expect(out).toHaveLength(2);
    const g = fakeClient({
      rpc: {
        claim_background_job: () => ({ data: [job(1)] }),
        complete_background_job: () => ({ data: true }),
      },
    });
    expect(
      await runDueJobs(
        g.client,
        { "evidence.cleanup_unregistered": async () => ({}) },
        "w1",
        3,
      ),
    ).toHaveLength(3);
  });
});
