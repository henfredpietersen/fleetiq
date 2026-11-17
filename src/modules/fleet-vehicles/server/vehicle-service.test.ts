import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import {
  cancelTransfer,
  createVehicle,
  decideTransfer,
  requestTransfer,
  setVehicleArchived,
  updateVehicle,
} from "./vehicle-service";

// Hand-rolled stand-in for the user-scoped client. Real behaviour (RLS, SQL functions, constraints) is
// covered by supabase/tests/database/phase2a_vehicles.test.sql; this proves the service validates
// first, calls only the intended entry points, and maps failures to safe messages.
type Reply = {
  data?: unknown;
  error?: { code?: string; message?: string } | null;
};
function fake(reply: Reply = { data: null, error: null }) {
  const calls: { kind: string; name: string; args: unknown }[] = [];
  const chain = (name: string, args: unknown) => {
    const q = {
      eq: () => q,
      select: () =>
        Promise.resolve({ data: reply.data ?? [], error: reply.error ?? null }),
    };
    calls.push({ kind: "update", name, args });
    return q;
  };
  const db = {
    rpc: (name: string, args: unknown) => {
      calls.push({ kind: "rpc", name, args });
      return Promise.resolve({
        data: reply.data ?? null,
        error: reply.error ?? null,
      });
    },
    from: (name: string) => ({ update: (args: unknown) => chain(name, args) }),
  } as unknown as SupabaseClient<Database>;
  return { db, calls };
}

const A = "5eed0000-0000-4000-8000-0000000000b1";
const B = "5eed0000-0000-4000-8000-0000000000b2";
const V = "5eed0000-0000-4000-8000-000000000101";
const form = {
  branchId: A,
  fleetNumber: "FL-001",
  registrationNumber: "test001-gp",
  make: "Toyota",
  model: "Hilux",
  vehicleCategory: "bakkie",
  vin: "",
  modelYear: "2020",
};

describe("createVehicle", () => {
  it("validates before touching the database", async () => {
    const { db, calls } = fake();
    const r = await createVehicle(db, { ...form, registrationNumber: "" });
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("calls only the create_vehicle function with normalised values", async () => {
    const { db, calls } = fake({ data: { id: V } });
    const r = await createVehicle(db, form);
    expect(r).toEqual({ ok: true, id: V });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ kind: "rpc", name: "create_vehicle" });
    expect(calls[0].args).toMatchObject({
      p_branch_id: A,
      p_registration_number: "TEST001-GP",
      p_model_year: 2020,
      p_administrative_status: "available",
    });
    // never sends a cache column
    expect(JSON.stringify(calls[0].args)).not.toMatch(
      /current_branch|odometer/,
    );
  });

  it("maps a duplicate registration to a clear message", async () => {
    const { db } = fake({
      error: {
        code: "23505",
        message:
          'duplicate key value violates unique constraint "vehicles_registration_uq"',
      },
    });
    const r = await createVehicle(db, form);
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.message).toMatch(/registration number already exists/);
  });

  it("maps a permission denial without leaking details", async () => {
    const { db } = fake({
      error: {
        code: "42501",
        message: "missing permission vehicle.manage for this branch",
      },
    });
    const r = await createVehicle(db, form);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toBe("You are not allowed to do this.");
  });

  it("reports an empty response as unavailable", async () => {
    const { db } = fake({ data: null });
    const r = await createVehicle(db, form);
    expect(r.ok).toBe(false);
  });
});

describe("updateVehicle", () => {
  const edit = { ...form, id: V, administrativeStatus: "available" };
  it("never writes caches, ids or the branch", async () => {
    const { db, calls } = fake({ data: [{ id: V }] });
    const r = await updateVehicle(db, edit);
    expect(r).toEqual({ ok: true, id: V });
    const written = Object.keys(calls[0].args as object);
    expect(written).toContain("make");
    for (const forbidden of [
      "id",
      "company_id",
      "current_branch_id",
      "current_odometer_km",
      "current_odometer_reading_id",
      "archived_at",
    ])
      expect(written).not.toContain(forbidden);
  });

  it("treats zero affected rows as not found / not allowed (RLS)", async () => {
    const { db } = fake({ data: [] });
    const r = await updateVehicle(db, edit);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/not found, or you are not allowed/);
  });

  it("rejects an invalid id before the database", async () => {
    const { db, calls } = fake();
    expect((await updateVehicle(db, { ...edit, id: "x" })).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("setVehicleArchived", () => {
  it("archives by setting archived_at, never deleting", async () => {
    const { db, calls } = fake({ data: [{ id: V }] });
    const r = await setVehicleArchived(db, { id: V, archived: "true" });
    expect(r).toEqual({ ok: true, id: V, archived: true });
    expect(Object.keys(calls[0].args as object)).toEqual(["archived_at"]);
    expect((calls[0].args as { archived_at: unknown }).archived_at).toEqual(
      expect.any(String),
    );
  });
  it("restores with archived_at null", async () => {
    const { db, calls } = fake({ data: [{ id: V }] });
    await setVehicleArchived(db, { id: V, archived: "false" });
    expect(calls[0].args).toEqual({ archived_at: null });
  });
  it("surfaces the archived-vehicle edit guard", async () => {
    const { db } = fake({
      error: { code: "55000", message: "an archived vehicle cannot be edited" },
    });
    const r = await setVehicleArchived(db, { id: V, archived: "true" });
    expect(r.ok).toBe(false);
  });
});

describe("requestTransfer", () => {
  const req = {
    vehicleId: V,
    toBranchId: B,
    reason: "Rebalancing",
    clientSubmissionId: A,
  };
  it("only creates a request via the function (no direct writes to assignments or the cache)", async () => {
    const { db, calls } = fake({ data: { id: A } });
    const r = await requestTransfer(db, req);
    expect(r).toEqual({ ok: true, approvalId: A });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      kind: "rpc",
      name: "request_vehicle_transfer",
    });
    expect(calls[0].args).toMatchObject({ p_client_submission_id: A });
  });
  it("requires a reason and an idempotency key", async () => {
    const { db, calls } = fake();
    expect((await requestTransfer(db, { ...req, reason: " " })).ok).toBe(false);
    expect(
      (await requestTransfer(db, { ...req, clientSubmissionId: "" })).ok,
    ).toBe(false);
    expect(calls).toHaveLength(0);
  });
  it("explains a second pending request", async () => {
    const { db } = fake({
      error: {
        code: "23505",
        message: 'unique constraint "approvals_one_pending_transfer"',
      },
    });
    const r = await requestTransfer(db, req);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/already has a transfer request/);
  });
});

describe("decideTransfer / cancelTransfer", () => {
  it("decides only through decide_approval", async () => {
    const { db, calls } = fake({ data: { id: A, status: "approved" } });
    const r = await decideTransfer(db, {
      approvalId: A,
      decision: "approved",
      notes: "ok",
    });
    expect(r).toEqual({ ok: true, decision: "approved" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ kind: "rpc", name: "decide_approval" });
  });
  it("reports segregation of duties (requester deciding their own request)", async () => {
    const { db } = fake({
      error: {
        code: "42501",
        message:
          "segregation of duties (DEC-24): you cannot decide your own request",
      },
    });
    const r = await decideTransfer(db, { approvalId: A, decision: "approved" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/another fleet administrator/i);
  });
  it("reports a missing approver permission as not allowed", async () => {
    const { db } = fake({
      error: {
        code: "42501",
        message: "missing permission vehicle.transfer.approve",
      },
    });
    const r = await decideTransfer(db, { approvalId: A, decision: "approved" });
    expect(r.ok).toBe(false);
  });
  it("refuses an invalid decision before the database", async () => {
    const { db, calls } = fake();
    expect(
      (await decideTransfer(db, { approvalId: A, decision: "cancelled" })).ok,
    ).toBe(false);
    expect(calls).toHaveLength(0);
  });
  it("cancels through cancel_approval", async () => {
    const { db, calls } = fake({ data: { id: A } });
    expect(await cancelTransfer(db, { approvalId: A })).toEqual({ ok: true });
    expect(calls[0]).toMatchObject({ kind: "rpc", name: "cancel_approval" });
  });
  it("reports an already-decided request", async () => {
    const { db } = fake({
      error: { code: "55000", message: "approval is already approved" },
    });
    const r = await cancelTransfer(db, { approvalId: A });
    expect(r.ok).toBe(false);
  });
});
