import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import {
  archiveTemplate,
  cancelShift,
  createAdHocShift,
  createTemplate,
  generateShifts,
  updateTemplate,
} from "./shift-service";
import { defaultRange } from "./queries";

// Stand-in for the user-scoped client. Real behaviour (RLS, SQL functions, constraints, idempotency) is covered by
// supabase/tests/database/phase3a_shifts.test.sql; this proves each service validates first, calls only the intended
// function, sends NULL for blanks, and maps failures to safe messages.
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

const B = "5eed0000-0000-4000-8000-0000000000b1";
const T = "5eed0000-0000-4000-8000-000000000801";
const S = "5eed0000-0000-4000-8000-000000000901";
const D = "5eed0000-0000-4000-8000-000000000a01";

describe("createTemplate", () => {
  it("validates before touching the database", async () => {
    const { db, calls } = fake();
    const r = await createTemplate(db, {
      branchId: B,
      name: "Day",
      startTime: "06:00",
      endTime: "06:00",
    });
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
  it("calls only create_shift_template with trimmed values", async () => {
    const { db, calls } = fake({ data: T });
    const r = await createTemplate(db, {
      branchId: B,
      name: " Night ",
      startTime: "18:00",
      endTime: "06:00",
    });
    expect(r).toEqual({ ok: true, id: T });
    expect(calls).toEqual([
      {
        name: "create_shift_template",
        args: {
          p_branch_id: B,
          p_name: "Night",
          p_start_time: "18:00",
          p_end_time: "06:00",
        },
      },
    ]);
  });
  it("maps a permission failure to a safe message", async () => {
    const { db } = fake({
      error: { code: "42501", message: "missing permission allocation.manage" },
    });
    const r = await createTemplate(db, {
      branchId: B,
      name: "Day",
      startTime: "06:00",
      endTime: "18:00",
    });
    expect(r).toEqual({
      ok: false,
      message: "You are not allowed to do this for that branch.",
    });
  });
  it("maps a duplicate name", async () => {
    const { db } = fake({
      error: {
        code: "23505",
        message: "an active shift template with that name already exists",
      },
    });
    const r = await createTemplate(db, {
      branchId: B,
      name: "Day",
      startTime: "06:00",
      endTime: "18:00",
    });
    expect(!r.ok && r.message).toMatch(/already exists/);
  });
});

describe("updateTemplate / archiveTemplate", () => {
  it("updates through update_shift_template", async () => {
    const { db, calls } = fake();
    expect(
      await updateTemplate(db, {
        templateId: T,
        name: "Day",
        startTime: "05:30",
        endTime: "17:30",
      }),
    ).toEqual({ ok: true });
    expect(calls[0].name).toBe("update_shift_template");
  });
  it("refuses to archive without a reason (no database call)", async () => {
    const { db, calls } = fake();
    expect((await archiveTemplate(db, { templateId: T, reason: " " })).ok).toBe(
      false,
    );
    expect(calls).toHaveLength(0);
  });
  it("archives with the reason and maps an already-archived template", async () => {
    const ok = fake();
    expect(
      await archiveTemplate(ok.db, { templateId: T, reason: "Discontinued" }),
    ).toEqual({ ok: true });
    expect(ok.calls[0]).toEqual({
      name: "archive_shift_template",
      args: { p_template_id: T, p_reason: "Discontinued" },
    });
    const bad = fake({
      error: {
        code: "55000",
        message: "an archived shift template cannot be changed",
      },
    });
    const r = await archiveTemplate(bad.db, { templateId: T, reason: "x" });
    expect(!r.ok && r.message).toMatch(/archived/);
  });
});

describe("generateShifts", () => {
  const raw = {
    templateId: T,
    from: "2026-12-01",
    to: "2026-12-07",
    clientSubmissionId: S,
  };
  it("refuses more than 31 days before calling the database", async () => {
    const { db, calls } = fake();
    const r = await generateShifts(db, { ...raw, to: "2027-01-01" });
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
  it("passes the submission id through and returns created and skipped", async () => {
    const { db, calls } = fake({ data: [{ created: 5, skipped: 2 }] });
    expect(await generateShifts(db, raw)).toEqual({
      ok: true,
      created: 5,
      skipped: 2,
    });
    expect(calls[0]).toEqual({
      name: "generate_shifts",
      args: {
        p_template_id: T,
        p_from: "2026-12-01",
        p_to: "2026-12-07",
        p_client_submission_id: S,
      },
    });
  });
  it("reports an archived template safely", async () => {
    const { db } = fake({
      error: {
        code: "55000",
        message: "an archived shift template cannot be used to generate shifts",
      },
    });
    const r = await generateShifts(db, raw);
    expect(!r.ok && r.message).toMatch(/archived/);
  });
});

describe("createAdHocShift", () => {
  const raw = {
    branchId: B,
    departmentId: "",
    shiftDate: "2026-12-20",
    startTime: "22:00",
    endTime: "00:30",
    clientSubmissionId: S,
  };
  it("sends NULL for a blank department", async () => {
    const { db, calls } = fake({ data: T });
    expect(await createAdHocShift(db, raw)).toEqual({ ok: true, id: T });
    expect(calls[0].name).toBe("create_shift");
    expect(calls[0].args).toMatchObject({
      p_department_id: null,
      p_client_submission_id: S,
    });
  });
  it("sends the department when chosen", async () => {
    const { db, calls } = fake({ data: T });
    await createAdHocShift(db, { ...raw, departmentId: D });
    expect(calls[0].args).toMatchObject({ p_department_id: D });
  });
  it("validates first", async () => {
    const { db, calls } = fake();
    expect((await createAdHocShift(db, { ...raw, endTime: "22:00" })).ok).toBe(
      false,
    );
    expect(calls).toHaveLength(0);
  });
});

describe("cancelShift", () => {
  it("needs a reason and then calls only cancel_shift", async () => {
    const none = fake();
    expect((await cancelShift(none.db, { shiftId: T, reason: "" })).ok).toBe(
      false,
    );
    expect(none.calls).toHaveLength(0);
    const ok = fake();
    expect(await cancelShift(ok.db, { shiftId: T, reason: "Holiday" })).toEqual(
      { ok: true },
    );
    expect(ok.calls).toEqual([
      {
        name: "cancel_shift",
        args: { p_shift_id: T, p_reason: "Holiday" },
      },
    ]);
  });
  it("maps a re-cancel and an active-allocations block", async () => {
    const again = fake({
      error: { code: "55000", message: "a cancelled shift cannot be changed" },
    });
    expect((await cancelShift(again.db, { shiftId: T, reason: "x" })).ok).toBe(
      false,
    );
    const live = fake({
      error: {
        code: "55000",
        message: "a shift with active allocations cannot be cancelled",
      },
    });
    const r = await cancelShift(live.db, { shiftId: T, reason: "x" });
    expect(!r.ok && r.message).toMatch(/active allocations/);
  });
});

describe("defaultRange", () => {
  it("is today and the next 13 days in Johannesburg time", () => {
    // 22:30 UTC on 31 Dec is already 1 Jan in Johannesburg
    expect(defaultRange(new Date("2026-12-31T22:30:00Z"))).toEqual({
      from: "2027-01-01",
      to: "2027-01-14",
    });
  });
});
