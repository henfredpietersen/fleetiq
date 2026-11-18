import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import {
  amendAllocationTimes,
  listMyAllocations,
  transitionAllocation,
} from "./lifecycle-service";

// Real behaviour (permissions, windows, licences, idempotency) is covered by phase3c_lifecycle.test.sql; this proves each
// service validates first, calls only the intended function with NULL for blanks, and shows the database's message.
type Reply = {
  data?: unknown;
  error?: { code?: string; message?: string; hint?: string } | null;
};
function fake(reply: Reply = {}) {
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
const A = "5eed0000-0000-4000-8000-000000000901";
const C = "5eed0000-0000-4000-8000-000000000a01";

describe("transitionAllocation", () => {
  it("validates first (unknown target, bad id, over-long reason)", async () => {
    const { db, calls } = fake();
    expect(
      (
        await transitionAllocation(db, {
          allocationId: A,
          toStatus: "closed",
          clientSubmissionId: C,
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await transitionAllocation(db, {
          allocationId: "x",
          toStatus: "cancelled",
          reason: "r",
          clientSubmissionId: C,
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await transitionAllocation(db, {
          allocationId: A,
          toStatus: "cancelled",
          reason: "x".repeat(501),
          clientSubmissionId: C,
        })
      ).ok,
    ).toBe(false);
    expect(calls).toHaveLength(0);
  });
  it("start sends NULL for a blank reason and returns the replayed flag", async () => {
    const { db, calls } = fake({
      data: [
        {
          out_allocation_id: A,
          out_status: "pre_inspection_pending",
          out_replayed: true,
        },
      ],
    });
    const r = await transitionAllocation(db, {
      allocationId: A,
      toStatus: "pre_inspection_pending",
      reason: "  ",
      clientSubmissionId: C,
    });
    expect(r).toEqual({
      ok: true,
      status: "pre_inspection_pending",
      replayed: true,
    });
    expect(calls[0]).toEqual({
      name: "transition_allocation",
      args: {
        p_allocation_id: A,
        p_to_status: "pre_inspection_pending",
        p_reason: null,
        p_client_submission_id: C,
      },
    });
  });
  it("shows the database's refusal message as is", async () => {
    const { db } = fake({
      error: {
        code: "55000",
        message:
          "it is too early to start this allocation: it can be started from 2026-11-18 07:00 (60 minutes before the planned start)",
        hint: "user_message",
      },
    });
    const r = await transitionAllocation(db, {
      allocationId: A,
      toStatus: "pre_inspection_pending",
      clientSubmissionId: C,
    });
    expect(r).toMatchObject({ ok: false });
    expect((r as { message: string }).message).toMatch(
      /^it is too early to start/,
    );
  });
});

describe("amendAllocationTimes", () => {
  const base = {
    allocationId: A,
    plannedStartAt: "2026-11-20T06:00:00+02:00",
    plannedEndAt: "2026-11-20T10:00:00+02:00",
    reason: "Run later",
    clientSubmissionId: C,
  };
  it("validates order and reason before calling", async () => {
    const { db, calls } = fake();
    expect(
      (
        await amendAllocationTimes(db, {
          ...base,
          plannedEndAt: base.plannedStartAt,
        })
      ).ok,
    ).toBe(false);
    expect((await amendAllocationTimes(db, { ...base, reason: " " })).ok).toBe(
      false,
    );
    expect(calls).toHaveLength(0);
  });
  it("calls amend_allocation_times", async () => {
    const { db, calls } = fake({ data: [{ out_replayed: false }] });
    expect(await amendAllocationTimes(db, base)).toEqual({
      ok: true,
      replayed: false,
    });
    expect(calls[0].name).toBe("amend_allocation_times");
  });
});

describe("listMyAllocations", () => {
  it("maps rows to camelCase and rejects a malformed range", async () => {
    const row = {
      allocation_id: A,
      status: "planned",
      planned_start_at: "s",
      planned_end_at: "e",
      shift_date: "2026-11-18",
      shift_start_at: "s",
      shift_end_at: "e",
      vehicle_fleet_number: "FL-001",
      vehicle_registration: "TEST001-GP",
      vehicle_make: "Toyota",
      vehicle_model: "Hilux",
      branch_name: "B1",
      licence_class_check: "matched",
      can_open: true,
      opened_on_behalf: false,
    };
    const { db, calls } = fake({ data: [row] });
    const bad = await listMyAllocations(db, { from: "nope", to: "x" });
    expect(bad.ok).toBe(false);
    const r = await listMyAllocations(db, {
      from: "2026-11-18T00:00:00Z",
      to: "2026-11-25T00:00:00Z",
    });
    expect(r.ok && r.allocations[0]).toMatchObject({
      id: A,
      fleetNumber: "FL-001",
      canOpen: true,
      openedOnBehalf: false,
    });
    expect(calls).toHaveLength(1);
  });
});
