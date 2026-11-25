import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import {
  listVehicleDamage,
  markDamageRepaired,
  recordOnboardingDamage,
  reportDamage,
  reviewDamage,
} from "./damage-service";
import {
  beginInspectionOnBehalf,
  confirmKnownDamage,
} from "./inspection-service";

// Behaviour (permissions, DEC-24, transitions, evidence rules) is covered by phase4c_damage_register.test.sql and
// phase4c_on_behalf.test.sql; this proves each service validates first, calls only the intended function with NULL for blanks,
// and shows the database's own message.
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
const id = (n: number) =>
  `5eed0000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const report = {
  inspectionId: id(1),
  zone: "roof",
  severity: "minor",
  description: "Dent",
  evidenceFileIds: [id(2)],
  clientSubmissionId: id(3),
};

describe("reportDamage", () => {
  it("validates first", async () => {
    const { db, calls } = fake();
    expect(
      (await reportDamage(db, { ...report, evidenceFileIds: [] })).ok,
    ).toBe(false);
    expect((await reportDamage(db, { ...report, zone: "nose" })).ok).toBe(
      false,
    );
    expect(calls).toHaveLength(0);
  });
  it("calls report_damage with NULL for the missing device time", async () => {
    const { db, calls } = fake({ data: id(9) });
    expect(await reportDamage(db, report)).toEqual({
      ok: true,
      damageId: id(9),
    });
    expect(calls[0]).toEqual({
      name: "report_damage",
      args: {
        p_inspection_id: id(1),
        p_zone: "roof",
        p_severity: "minor",
        p_description: "Dent",
        p_evidence_file_ids: [id(2)],
        p_device_reported_at: null,
        p_captured_offline: false,
        p_client_submission_id: id(3),
      },
    });
  });
  it("shows the database's own message", async () => {
    const { db } = fake({
      error: {
        code: "IN010",
        message: "Photos must come from the in-app camera.",
        hint: "user_message",
      },
    });
    expect(await reportDamage(db, report)).toMatchObject({
      ok: false,
      message: "Photos must come from the in-app camera.",
    });
  });
});

describe("onboarding, review, repair, known-damage confirmation, on-behalf start", () => {
  it("onboarding calls record_onboarding_damage", async () => {
    const { db, calls } = fake({ data: id(9) });
    const { inspectionId: _i, ...rest } = report;
    void _i;
    const r = await recordOnboardingDamage(db, { ...rest, vehicleId: id(4) });
    expect(r.ok).toBe(true);
    expect(calls[0]!.name).toBe("record_onboarding_damage");
    expect(calls[0]!.args.p_vehicle_id).toBe(id(4));
  });
  it("a dispute without a reason never reaches the database", async () => {
    const { db, calls } = fake({ data: id(9) });
    const base = { itemId: id(1), clientSubmissionId: id(2) };
    expect((await reviewDamage(db, { ...base, decision: "disputed" })).ok).toBe(
      false,
    );
    expect(calls).toHaveLength(0);
    expect((await reviewDamage(db, { ...base, decision: "verified" })).ok).toBe(
      true,
    );
    expect(calls[0]!.args).toEqual({
      p_item_id: id(1),
      p_decision: "verified",
      p_reason: null,
      p_client_submission_id: id(2),
    });
  });
  it("own-report refusal (DM003) is shown as the database wrote it", async () => {
    const { db } = fake({
      error: {
        code: "DM003",
        message:
          "You cannot review damage you reported yourself; another manager must verify or dispute it.",
        hint: "user_message",
      },
    });
    const r = await reviewDamage(db, {
      itemId: id(1),
      decision: "verified",
      clientSubmissionId: id(2),
    });
    expect(r).toMatchObject({
      ok: false,
      message:
        "You cannot review damage you reported yourself; another manager must verify or dispute it.",
    });
  });
  it("mark repaired needs a note", async () => {
    const { db, calls } = fake({ data: id(9) });
    expect(
      (
        await markDamageRepaired(db, {
          itemId: id(1),
          note: " ",
          clientSubmissionId: id(2),
        })
      ).ok,
    ).toBe(false);
    expect(calls).toHaveLength(0);
    expect(
      (
        await markDamageRepaired(db, {
          itemId: id(1),
          note: "Fixed",
          clientSubmissionId: id(2),
        })
      ).ok,
    ).toBe(true);
    expect(calls[0]!.name).toBe("mark_damage_repaired");
  });
  it("confirmKnownDamage and beginInspectionOnBehalf call their functions", async () => {
    const a = fake({ data: id(9) });
    expect(
      (
        await confirmKnownDamage(a.db, {
          inspectionId: id(1),
          clientSubmissionId: id(2),
        })
      ).ok,
    ).toBe(true);
    expect(a.calls[0]!.name).toBe("confirm_known_damage_reviewed");
    const b = fake({ data: id(9) });
    expect(
      (
        await beginInspectionOnBehalf(b.db, {
          allocationId: id(1),
          reason: "",
          clientSubmissionId: id(2),
        })
      ).ok,
    ).toBe(false);
    expect(b.calls).toHaveLength(0);
    const r = await beginInspectionOnBehalf(b.db, {
      allocationId: id(1),
      reason: "Driver unwell",
      clientSubmissionId: id(2),
    });
    expect(r).toEqual({ ok: true, inspectionId: id(9) });
    expect(b.calls[0]).toEqual({
      name: "begin_inspection_on_behalf",
      args: {
        p_allocation_id: id(1),
        p_reason: "Driver unwell",
        p_device_started_at: null,
        p_captured_offline: false,
        p_client_submission_id: id(2),
      },
    });
  });
});

describe("listVehicleDamage", () => {
  it("maps rows, marks the caller's own reports and reads no names", async () => {
    const rows = [
      {
        id: id(1),
        zone: "left_front",
        severity: "minor",
        description: "Scratch",
        status: "reported",
        source: "onboarding",
        reported_at: "2026-11-24T08:00:00Z",
        reported_by: id(7),
        reviewed_at: null,
        review_reason: null,
        repaired_at: null,
        repair_note: null,
        vehicle_damage_evidence: [
          { evidence_file_id: id(5), added_at: "2026-11-24T08:00:01Z" },
        ],
      },
    ];
    let selected = "";
    const q: Record<string, unknown> = {};
    q.select = (s: string) => ((selected = s), q);
    q.eq = () => q;
    q.order = () => q;
    q.limit = () => Promise.resolve({ data: rows, error: null });
    const db = { from: () => q } as unknown as SupabaseClient<Database>;
    const r = await listVehicleDamage(db, id(4), id(7));
    expect(r.ok && r.items[0]).toMatchObject({
      zoneLabel: "Left front (door and wing)",
      reportedByMe: true,
      photoIds: [id(5)],
    });
    expect(selected).not.toMatch(/display_name|profiles|email/);
  });
});
