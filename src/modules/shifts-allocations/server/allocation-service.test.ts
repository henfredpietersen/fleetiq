import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import {
  checkEligibility,
  decideLicenceOverride,
  requestAllocation,
  setRequiredLicenceCode,
} from "./allocation-service";

// Stand-in for the user-scoped client. Real behaviour (RLS, functions, constraints, idempotency, segregation of duties)
// is covered by supabase/tests/database/phase3b_allocations.test.sql; this proves each service validates first, calls
// only the intended function with NULL for blanks, and maps failures to safe messages.
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
const S = "5eed0000-0000-4000-8000-000000000901";
const V = "5eed0000-0000-4000-8000-000000000101";
const D = "5eed0000-0000-4000-8000-000000000301";
const C = "5eed0000-0000-4000-8000-000000000a01";

describe("checkEligibility", () => {
  it("validates first", async () => {
    const { db, calls } = fake();
    expect((await checkEligibility(db, { shiftId: "x" })).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
  it("maps the row to camelCase and sends no times", async () => {
    const { db, calls } = fake({
      data: [
        {
          ok: true,
          block_reasons: [],
          licence_class_check: null,
          needs_override: true,
        },
      ],
    });
    const r = await checkEligibility(db, {
      shiftId: S,
      vehicleId: V,
      driverId: D,
    });
    expect(r).toEqual({
      ok: true,
      result: {
        ok: true,
        blockReasons: [],
        licenceClassCheck: null,
        needsOverride: true,
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("allocation_eligibility");
    expect(calls[0]!.args.p_planned_start_at).toBeNull();
    expect(calls[0]!.args.p_planned_end_at).toBeNull();
  });
  it("a permission failure becomes a safe message", async () => {
    const { db } = fake({
      error: { code: "42501", message: "missing permission allocation.manage" },
    });
    const r = await checkEligibility(db, {
      shiftId: S,
      vehicleId: V,
      driverId: D,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/not allowed/);
  });
});

describe("requestAllocation", () => {
  const input = {
    shiftId: S,
    vehicleId: V,
    driverId: D,
    clientSubmissionId: C,
  };
  it("validates before touching the database", async () => {
    const { db, calls } = fake();
    expect(
      (await requestAllocation(db, { ...input, driverId: "nope" })).ok,
    ).toBe(false);
    expect(calls).toHaveLength(0);
  });
  it("calls only request_allocation, sending NULL for the blank reason and times", async () => {
    const { db, calls } = fake({
      data: [{ allocation_id: "a1", approval_id: null }],
    });
    const r = await requestAllocation(db, { ...input, reason: " " });
    expect(r).toEqual({ ok: true, allocationId: "a1", approvalId: null });
    expect(calls.map((c) => c.name)).toEqual(["request_allocation"]);
    expect(calls[0]!.args).toMatchObject({
      p_reason: null,
      p_planned_start_at: null,
      p_planned_end_at: null,
      p_client_submission_id: C,
    });
  });
  it("a class mismatch returns the approval id and no allocation", async () => {
    const { db } = fake({
      data: [{ allocation_id: null, approval_id: "ap1" }],
    });
    expect(await requestAllocation(db, { ...input, reason: "Cover" })).toEqual({
      ok: true,
      allocationId: null,
      approvalId: "ap1",
    });
  });
  it("an overlap is reported in plain words", async () => {
    const { db } = fake({
      error: {
        code: "23P01",
        message: "driver already allocated during that period",
      },
    });
    const r = await requestAllocation(db, input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/driver is already allocated/);
  });
});

describe("decideLicenceOverride", () => {
  it("validates, then calls only decide_approval", async () => {
    const bad = fake();
    expect(
      (
        await decideLicenceOverride(bad.db, {
          approvalId: C,
          decision: "maybe",
        })
      ).ok,
    ).toBe(false);
    expect(bad.calls).toHaveLength(0);
    const good = fake({ data: {} });
    expect(
      await decideLicenceOverride(good.db, {
        approvalId: C,
        decision: "approved",
        notes: "",
      }),
    ).toEqual({ ok: true });
    expect(good.calls[0]).toEqual({
      name: "decide_approval",
      args: { p_approval_id: C, p_decision: "approved", p_notes: null },
    });
  });
  it("the database's segregation-of-duties refusal is surfaced", async () => {
    const { db } = fake({
      error: {
        code: "42501",
        message:
          "segregation of duties (DEC-24): the driver cannot approve their own licence override",
      },
    });
    const r = await decideLicenceOverride(db, {
      approvalId: C,
      decision: "approved",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/driver cannot approve/);
  });
});

describe("setRequiredLicenceCode", () => {
  it("sends the code, or NULL to clear, with the reason", async () => {
    const a = fake();
    expect(
      await setRequiredLicenceCode(a.db, {
        vehicleId: V,
        code: "C1",
        reason: "GVM 8,000 kg",
      }),
    ).toEqual({ ok: true });
    expect(a.calls[0]).toEqual({
      name: "set_vehicle_required_licence_code",
      args: { p_vehicle_id: V, p_code: "C1", p_reason: "GVM 8,000 kg" },
    });
    const b = fake();
    await setRequiredLicenceCode(b.db, {
      vehicleId: V,
      code: "",
      reason: "Unknown",
    });
    expect(b.calls[0]!.args.p_code).toBeNull();
  });
  it("refuses an unknown code before calling the database", async () => {
    const { db, calls } = fake();
    expect(
      (
        await setRequiredLicenceCode(db, {
          vehicleId: V,
          code: "D",
          reason: "x",
        })
      ).ok,
    ).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
