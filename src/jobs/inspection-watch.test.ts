import { describe, expect, it } from "vitest";
import { called, fakeClient } from "@/test/fake-supabase";
import {
  enqueueInspectionWatch,
  inspectionWatchBucket,
  inspectionWatchHandler,
  inspectionWatchKey,
} from "./inspection-watch";

const C = "00000000-0000-4000-8000-0000000000c1";

describe("inspection_watch job (DEC-43)", () => {
  it("the idempotency key is one per company and 5-minute bucket", () => {
    expect(inspectionWatchBucket(new Date("2026-11-25T08:04:59Z"))).toBe(
      "2026-11-25T08:00",
    );
    expect(inspectionWatchBucket(new Date("2026-11-25T08:05:00Z"))).toBe(
      "2026-11-25T08:05",
    );
    expect(inspectionWatchKey(C, new Date("2026-11-25T08:07:30Z"))).toBe(
      `inspection_watch:${C}:2026-11-25T08:05`,
    );
    expect(
      inspectionWatchKey(C, new Date("2026-11-25T08:07:30Z")) ===
        inspectionWatchKey(C, new Date("2026-11-25T08:09:59Z")),
    ).toBe(true);
    expect(
      inspectionWatchKey(C, new Date("2026-11-25T08:07:30Z"), true),
    ).toContain(":manual:");
  });

  it("enqueues with the company and the bucket key", async () => {
    const f = fakeClient({
      rpc: { enqueue_background_job: () => ({ data: "job-1" }) },
    });
    expect(
      await enqueueInspectionWatch(f.client, C, {
        now: new Date("2026-11-25T08:07:30Z"),
      }),
    ).toBe("job-1");
    expect(
      called(f.calls, "rpc:enqueue_background_job")[0]!.args[0],
    ).toMatchObject({
      p_job_type: "inspection_watch",
      p_idempotency_key: `inspection_watch:${C}:2026-11-25T08:05`,
      p_company_id: C,
    });
  });

  it("an enqueue error is thrown, never swallowed", async () => {
    const f = fakeClient({
      rpc: {
        enqueue_background_job: () => ({ error: { message: "down" } }),
      },
    });
    await expect(enqueueInspectionWatch(f.client, C)).rejects.toThrow(/down/);
  });

  it("the handler runs run_inspection_watch for the job's company and returns its summary", async () => {
    const f = fakeClient({
      rpc: {
        run_inspection_watch: () => ({ data: { inserted: 2, resolved: 1 } }),
      },
    });
    const h = inspectionWatchHandler(
      f.client,
      () => new Date("2026-11-25T08:07:30Z"),
    );
    const r = await h({ company_id: C } as never);
    expect(r).toEqual({ inserted: 2, resolved: 1 });
    expect(called(f.calls, "rpc:run_inspection_watch")[0]!.args[0]).toEqual({
      p_company_id: C,
      p_now: "2026-11-25T08:07:30.000Z",
    });
  });

  it("the handler fails the job (the worker retries) when the function errors or the job has no company", async () => {
    const f = fakeClient({
      rpc: { run_inspection_watch: () => ({ error: { message: "boom" } }) },
    });
    await expect(
      inspectionWatchHandler(f.client)({ company_id: C } as never),
    ).rejects.toThrow(/boom/);
    await expect(
      inspectionWatchHandler(f.client)({ company_id: null } as never),
    ).rejects.toThrow(/company/);
  });
});
