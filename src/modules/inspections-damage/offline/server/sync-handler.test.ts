import { describe, expect, it } from "vitest";
import { fakeClient } from "@/test/fake-supabase";
import { handleSync, statusForRefusal, type SyncDeps } from "./sync-handler";

const U = "00000000-0000-4000-8000-000000000001";
const A = "00000000-0000-4000-8000-0000000000a1";
const CS = "00000000-0000-4000-8000-0000000000c1";
const deps = (
  rpc: Record<
    string,
    () => { data?: unknown; error?: { message: string; code?: string } | null }
  >,
): SyncDeps => ({
  userId: U,
  db: fakeClient({ rpc }).client,
  evidence: async () => {
    throw new Error("not used");
  },
});
const begin = {
  op: "begin",
  profileId: U,
  allocationId: A,
  stage: "pre_shift",
  capturedOffline: true,
  clientSubmissionId: CS,
};

describe("POST /api/inspection-sync — what the phone is told", () => {
  it("refuses work saved under another profile with 401, before touching the database", async () => {
    const r = await handleSync(deps({}), {
      ...begin,
      profileId: "00000000-0000-4000-8000-000000000002",
    });
    expect(r.status).toBe(401);
    expect(r.body).toMatchObject({ ok: false, code: "WRONG_USER" });
  });
  it("an invalid envelope is refused as 422", async () => {
    expect(
      (await handleSync(deps({}), { op: "nope", profileId: U })).status,
    ).toBe(422);
  });
  it("begin: 200 with the inspection id", async () => {
    const r = await handleSync(
      deps({ begin_inspection: () => ({ data: "insp-1" }) }),
      begin,
    );
    expect(r).toEqual({
      status: 200,
      body: { ok: true, inspectionId: "insp-1" },
    });
  });
  it("a database refusal keeps its code and the database's own message: 403 / 404 / 409", async () => {
    for (const [code, status] of [
      ["42501", 403],
      ["P0002", 404],
      ["55000", 409],
      ["IN006", 409],
      ["22023", 409],
    ] as const) {
      const r = await handleSync(
        deps({ begin_inspection: () => ({ error: { code, message: "x" } }) }),
        begin,
      );
      expect(r.status).toBe(status);
      expect(r.body.code).toBe(code);
    }
  });
  it("a database that is down is retryable (503), as is our own 'something went wrong'", async () => {
    expect(statusForRefusal("08006")).toBe(503);
    expect(statusForRefusal("40001")).toBe(503);
    expect(statusForRefusal("57014")).toBe(503);
    expect(statusForRefusal("PGRST000")).toBe(503);
    expect(statusForRefusal(undefined)).toBe(503);
    expect(statusForRefusal(undefined, ["Take at least one photo"])).toBe(422);
    expect(statusForRefusal("PGRST301")).toBe(401);
    const r = await handleSync(
      deps({ begin_inspection: () => ({ data: null }) }),
      begin,
    );
    expect(r.status).toBe(503);
  });
  it("a thrown error is retryable, never a refusal", async () => {
    const r = await handleSync(
      deps({
        begin_inspection: () => {
          throw new Error("socket hang up");
        },
      }),
      begin,
    );
    expect(r.status).toBe(503);
  });
  it("report_conflict sends explicit nulls for the optional arguments (an omitted one would not match the function)", async () => {
    let args: Record<string, unknown> = {};
    const f = fakeClient({
      rpc: {
        report_sync_conflict: (a) => {
          args = a;
          return { data: "conf-1" };
        },
      },
    });
    await handleSync(
      {
        userId: U,
        db: f.client,
        evidence: async () => {
          throw new Error("x");
        },
      },
      {
        op: "report_conflict",
        profileId: U,
        allocationId: A,
        inspectionId: null,
        functionName: "begin_inspection",
        refusalCode: "55000",
        refusalMessage: "Cancelled.",
        clientSubmissionId: CS,
      },
    );
    expect(args).toHaveProperty("p_inspection_id", null);
    expect(args).toHaveProperty("p_device_time", null);
  });
  it("report_conflict stores the refusal only", async () => {
    let args: Record<string, unknown> = {};
    const f = fakeClient({
      rpc: {
        report_sync_conflict: (a) => {
          args = a;
          return { data: "conf-1" };
        },
      },
    });
    const r = await handleSync(
      {
        userId: U,
        db: f.client,
        evidence: async () => {
          throw new Error("x");
        },
      },
      {
        op: "report_conflict",
        profileId: U,
        allocationId: A,
        inspectionId: null,
        functionName: "begin_inspection",
        refusalCode: "55000",
        refusalMessage: "Cancelled.",
        deviceTime: "2026-11-25T08:00:00.000Z",
        clientSubmissionId: CS,
      },
    );
    expect(r).toEqual({
      status: 200,
      body: { ok: true, conflictId: "conf-1" },
    });
    expect(Object.keys(args).sort()).toEqual([
      "p_allocation_id",
      "p_client_submission_id",
      "p_device_time",
      "p_function_name",
      "p_inspection_id",
      "p_refusal_code",
      "p_refusal_message",
    ]);
  });
});

describe("POST /api/inspection-sync — the driver's reading (5A, DEC-05, DEC-06)", () => {
  const INS = "00000000-0000-4000-8000-0000000000b1";
  const reading = {
    op: "record_reading",
    profileId: U,
    inspectionId: INS,
    readingKm: 123456,
    deviceTime: "2026-11-25T08:00:00.000Z",
    capturedOffline: true,
    clientSubmissionId: CS,
  };
  it("calls record_driver_reading as the signed-in user with the device context and the item's own client_submission_id", async () => {
    const seen: Record<string, unknown>[] = [];
    const r = await handleSync(
      deps({
        record_driver_reading: () => ({ data: "reading-1" }),
      }),
      reading,
    );
    expect(r).toEqual({ status: 200, body: { ok: true } });
    const fake = fakeClient({
      rpc: {
        record_driver_reading: (a) => {
          seen.push(a);
          return { data: "reading-1" };
        },
      },
    });
    await handleSync({ ...deps({}), db: fake.client }, reading);
    expect(seen[0]).toEqual({
      p_inspection_id: INS,
      p_reading_km: 123456,
      p_device_time: "2026-11-25T08:00:00.000Z",
      p_captured_offline: true,
      p_client_submission_id: CS,
    });
  });
  it("refuses a reading that is not whole km in range with 422 before the database is called", async () => {
    for (const km of [-1, 1.5, 10_000_000, "12"]) {
      const r = await handleSync(deps({}), { ...reading, readingKm: km });
      expect(r.status).toBe(422);
    }
  });
  it("a database refusal keeps its code and message (IN006 / 55000 / 42501 are conflicts, a down database is retried)", async () => {
    for (const [code, status] of [
      ["IN006", 409],
      ["55000", 409],
      ["42501", 403],
      ["08006", 503],
    ] as const) {
      const r = await handleSync(
        deps({
          record_driver_reading: () => ({ error: { code, message: "x" } }),
        }),
        reading,
      );
      expect(r.status).toBe(status);
      expect(r.body.code).toBe(code);
    }
  });
  it("the answer carries no OCR value (DEC-05)", async () => {
    const r = await handleSync(
      deps({ record_driver_reading: () => ({ data: "reading-1" }) }),
      reading,
    );
    expect(JSON.stringify(r)).not.toMatch(/ocr/i);
  });
});
