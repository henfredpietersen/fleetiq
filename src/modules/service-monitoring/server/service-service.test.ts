import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import {
  attachEvidence,
  changeCompanyDefault,
  createRecord,
  decideOverride,
  requestOverride,
  reverseVerification,
  stageImport,
  verifyRecord,
} from "./service-service";

// Stand-in for the user-scoped client. Real behaviour (RLS, SQL functions, DEC-24, constraints) is covered by
// supabase/tests/database/phase2c_service_baseline.test.sql; this proves each service validates first, calls only
// the intended function, sends NULL for blanks, and maps failures to safe messages.
type Reply = {
  data?: unknown;
  error?: { code?: string; message?: string } | null;
};
function fake(reply: Reply = { data: null, error: null }) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const db = {
    rpc: (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return Promise.resolve({
        data: reply.data ?? null,
        error: reply.error ?? null,
      });
    },
  } as unknown as SupabaseClient<Database>;
  return { db, calls };
}

const U = "5eed0000-0000-4000-8000-000000000101";
const S = "5eed0000-0000-4000-8000-0000000000b1";
const cfg = {
  serviceIntervalKm: "15000",
  earlyToleranceKm: "1500",
  lateToleranceKm: "1500",
  reason: "Policy",
};

describe("changeCompanyDefault", () => {
  it("validates before touching the database", async () => {
    const { db, calls } = fake();
    expect(
      (await changeCompanyDefault(db, { ...cfg, serviceIntervalDays: "180" }))
        .ok,
    ).toBe(false);
    expect(calls).toHaveLength(0);
  });
  it("calls only the effective-dated change function and sends NULL for the time basis", async () => {
    const { db, calls } = fake({ data: { id: U } });
    expect(await changeCompanyDefault(db, cfg)).toEqual({ ok: true, id: U });
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("change_company_default_service_config");
    expect(calls[0].args).toMatchObject({
      p_interval_km: 15000,
      p_interval_days: null,
      p_early_days: null,
      p_late_days: null,
    });
  });
  it("maps a missing permission to a safe message", async () => {
    const { db } = fake({
      error: {
        code: "42501",
        message: "missing company-wide permission service.config.manage",
      },
    });
    const r = await changeCompanyDefault(db, cfg);
    expect(r).toEqual({
      ok: false,
      message: "You are not allowed to do this.",
    });
  });
});

describe("requestOverride", () => {
  const base = {
    ...cfg,
    scope: "category",
    vehicleCategory: "bakkie",
    clientSubmissionId: S,
  };
  it("an override is only ever REQUESTED (approvals), never written directly", async () => {
    const { db, calls } = fake({ data: { id: U } });
    expect(await requestOverride(db, base)).toEqual({
      ok: true,
      approvalId: U,
    });
    expect(calls.map((c) => c.name)).toEqual([
      "request_service_config_override",
    ]);
    expect(calls[0].args).toMatchObject({
      p_scope: "category",
      p_vehicle_category: "bakkie",
      p_vehicle_id: null,
      p_make: null,
      p_client_submission_id: S,
    });
  });
  it("needs a reason and a target before calling the database", async () => {
    const { db, calls } = fake();
    expect((await requestOverride(db, { ...base, reason: "" })).ok).toBe(false);
    expect(
      (await requestOverride(db, { ...base, vehicleCategory: "" })).ok,
    ).toBe(false);
    expect(calls).toHaveLength(0);
  });
  it("shows the pending-request message for a duplicate target", async () => {
    const { db } = fake({
      error: {
        code: "55000",
        message:
          "an override request for this target is already waiting for approval",
      },
    });
    const r = await requestOverride(db, base);
    expect(!r.ok && r.message).toMatch(/already waiting for approval/);
  });
});

describe("decideOverride (DEC-24)", () => {
  it("goes through decide_approval only", async () => {
    const { db, calls } = fake({ data: {} });
    expect(
      await decideOverride(db, { approvalId: U, decision: "approved" }),
    ).toEqual({ ok: true, decision: "approved" });
    expect(calls.map((c) => c.name)).toEqual(["decide_approval"]);
  });
  it("tells the requester to ask someone else", async () => {
    const { db } = fake({
      error: {
        code: "42501",
        message:
          "segregation of duties (DEC-24): you cannot decide your own request",
      },
    });
    const r = await decideOverride(db, { approvalId: U, decision: "approved" });
    expect(!r.ok && r.message).toMatch(/Someone else must do it/);
  });
});

describe("createRecord", () => {
  const rec = {
    vehicleId: U,
    serviceDate: "2026-10-01",
    odometerKm: "82400",
    serviceType: "Scheduled service",
    clientSubmissionId: S,
  };
  it("is idempotent by construction: always sends the client_submission_id", async () => {
    const { db, calls } = fake({ data: S });
    expect(await createRecord(db, rec)).toEqual({ ok: true, id: S });
    expect(calls[0].name).toBe("create_service_record");
    expect(calls[0].args).toMatchObject({
      p_source: "workshop",
      p_odometer_km: 82400,
      p_evidence_file_id: null,
      p_client_submission_id: S,
    });
  });
  it("never accepts historical_import, a future date or a negative odometer", async () => {
    const { db, calls } = fake();
    expect(
      (await createRecord(db, { ...rec, source: "historical_import" })).ok,
    ).toBe(false);
    expect(
      (await createRecord(db, { ...rec, serviceDate: "2999-01-01" })).ok,
    ).toBe(false);
    expect((await createRecord(db, { ...rec, odometerKm: "-1" })).ok).toBe(
      false,
    );
    expect(calls).toHaveLength(0);
  });
});

describe("verifyRecord / reverseVerification (DEC-24)", () => {
  it("the creator is refused by the database and told so plainly", async () => {
    const { db } = fake({
      error: {
        code: "42501",
        message: "nobody verifies or rejects a record they created (DEC-24)",
      },
    });
    const r = await verifyRecord(db, { recordId: U, decision: "verified" });
    expect(!r.ok && r.message).toMatch(/Someone else must do it/);
  });
  it("rejecting without a reason never reaches the database", async () => {
    const { db, calls } = fake();
    expect(
      (await verifyRecord(db, { recordId: U, decision: "rejected" })).ok,
    ).toBe(false);
    expect(calls).toHaveLength(0);
  });
  it("a reversal needs a reason and calls only the audited reversal function", async () => {
    const { db, calls } = fake({ data: null });
    expect(
      (await reverseVerification(db, { recordId: U, reason: " " })).ok,
    ).toBe(false);
    expect(calls).toHaveLength(0);
    expect(
      (await reverseVerification(db, { recordId: U, reason: "Wrong vehicle" }))
        .ok,
    ).toBe(true);
    expect(calls.map((c) => c.name)).toEqual(["reverse_service_verification"]);
  });
});

describe("stageImport / attachEvidence (DEC-20)", () => {
  const csv =
    "registration_number,service_date,odometer_km,service_type\nTEST001-GP,2026-10-01,82400,Scheduled service";
  it("parses the file, then stages through the database (which validates every value)", async () => {
    const { db, calls } = fake({ data: U });
    expect(
      await stageImport(db, {
        filename: "go-live.csv",
        csvText: csv,
        clientSubmissionId: S,
      }),
    ).toEqual({ ok: true, batchId: U });
    expect(calls.map((c) => c.name)).toEqual(["stage_service_import"]);
    expect(calls[0].args.p_rows).toEqual([
      {
        registration_number: "TEST001-GP",
        service_date: "2026-10-01",
        odometer_km: "82400",
        service_type: "Scheduled service",
      },
    ]);
  });
  it("a malformed file never reaches the database", async () => {
    const { db, calls } = fake();
    const r = await stageImport(db, {
      filename: "x.csv",
      csvText: "a,b\n1,2",
      clientSubmissionId: S,
    });
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
  it("attaching evidence creates the record only through the reviewed function", async () => {
    const { db, calls } = fake({ data: S });
    const r = await attachEvidence(db, {
      rowId: U,
      batchId: S,
      evidenceFileId: U,
      clientSubmissionId: S,
    });
    expect(r).toEqual({ ok: true, recordId: S, batchId: S });
    expect(calls.map((c) => c.name)).toEqual(["attach_import_row_evidence"]);
  });
  it("no evidence, no call", async () => {
    const { db, calls } = fake();
    expect(
      (
        await attachEvidence(db, {
          rowId: U,
          batchId: S,
          clientSubmissionId: S,
        })
      ).ok,
    ).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
