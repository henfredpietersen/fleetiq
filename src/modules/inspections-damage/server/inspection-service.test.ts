import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import {
  attachDefectPhoto,
  attachOdometerPhoto,
  beginInspection,
  getMyInspection,
  listInspections,
  saveResponses,
  submitInspection,
} from "./inspection-service";

// Real behaviour (permissions, answers, photos, submission rules, idempotency) is covered by phase4a_inspections.test.sql;
// this proves each service validates first, calls only the intended function with NULL for blanks, parses what comes back,
// and shows the database's message.
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
const I = "5eed0000-0000-4000-8000-000000000a01";
const C = "5eed0000-0000-4000-8000-000000000b01";

describe("beginInspection", () => {
  it("validates first: nothing is called for a bad stage or id", async () => {
    const { db, calls } = fake();
    expect(
      (
        await beginInspection(db, {
          allocationId: A,
          stage: "mid",
          clientSubmissionId: C,
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await beginInspection(db, {
          allocationId: "x",
          stage: "pre_shift",
          clientSubmissionId: C,
        })
      ).ok,
    ).toBe(false);
    expect(calls).toHaveLength(0);
  });
  it("calls begin_inspection with NULL for a missing device time and returns the id", async () => {
    const { db, calls } = fake({ data: I });
    const r = await beginInspection(db, {
      allocationId: A,
      stage: "pre_shift",
      clientSubmissionId: C,
    });
    expect(r).toEqual({ ok: true, inspectionId: I });
    expect(calls[0]).toEqual({
      name: "begin_inspection",
      args: {
        p_allocation_id: A,
        p_stage: "pre_shift",
        p_device_started_at: null,
        p_captured_offline: false,
        p_client_submission_id: C,
      },
    });
  });
  it("passes the offline flag and the device time through (DEC-06)", async () => {
    const { db, calls } = fake({ data: I });
    await beginInspection(db, {
      allocationId: A,
      stage: "post_shift",
      clientSubmissionId: C,
      capturedOffline: true,
      deviceStartedAt: "2026-11-18T05:00:00+02:00",
    });
    expect(calls[0].args).toMatchObject({
      p_stage: "post_shift",
      p_captured_offline: true,
      p_device_started_at: "2026-11-18T05:00:00+02:00",
    });
  });
  it("shows the database's refusal as is", async () => {
    const { db } = fake({
      error: {
        code: "55000",
        message:
          "the pre-shift inspection can only be started once the allocation has been started",
        hint: "user_message",
      },
    });
    const r = await beginInspection(db, {
      allocationId: A,
      stage: "pre_shift",
      clientSubmissionId: C,
    });
    expect(r).toEqual({
      ok: false,
      message:
        "the pre-shift inspection can only be started once the allocation has been started",
    });
  });
});

describe("saveResponses", () => {
  it("maps answers to the function's jsonb, blanks to NULL", async () => {
    const { db, calls } = fake({ data: I });
    const r = await saveResponses(db, {
      inspectionId: I,
      clientSubmissionId: C,
      vehicleConfirmed: true,
      responses: [
        { templateItemId: A, value: "defect", comment: " Cut " },
        { templateItemId: A, value: "ok" },
      ],
    });
    expect(r.ok).toBe(true);
    expect(calls[0].name).toBe("save_inspection_responses");
    expect(calls[0].args).toEqual({
      p_inspection_id: I,
      p_responses: [
        {
          template_item_id: A,
          value: "defect",
          comment: "Cut",
          device_answered_at: null,
        },
        {
          template_item_id: A,
          value: "ok",
          comment: null,
          device_answered_at: null,
        },
      ],
      p_vehicle_confirmed: true,
      p_client_submission_id: C,
    });
  });
  it("validates first (bad question id) and never calls the database", async () => {
    const { db, calls } = fake();
    expect(
      (
        await saveResponses(db, {
          inspectionId: I,
          clientSubmissionId: C,
          responses: [{ templateItemId: "x", value: "ok" }],
        })
      ).ok,
    ).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("submitInspection", () => {
  it("returns the flags the database computed", async () => {
    const { db, calls } = fake({
      data: [
        {
          out_inspection_id: I,
          out_status: "submitted",
          out_late_flag: true,
          out_safety_defect_flag: false,
          out_replayed: false,
        },
      ],
    });
    const r = await submitInspection(db, {
      inspectionId: I,
      clientSubmissionId: C,
      capturedOffline: true,
    });
    expect(r).toEqual({
      ok: true,
      status: "submitted",
      lateFlag: true,
      safetyDefectFlag: false,
      replayed: false,
    });
    expect(calls[0].args).toEqual({
      p_inspection_id: I,
      p_device_submitted_at: null,
      p_captured_offline: true,
      p_client_submission_id: C,
    });
  });
  it("shows a refusal such as the missing odometer photo, as is", async () => {
    const { db } = fake({
      error: {
        code: "IN006",
        message:
          "The odometer photo is required: take a photo of the odometer before you submit.",
        hint: "user_message",
      },
    });
    const r = await submitInspection(db, {
      inspectionId: I,
      clientSubmissionId: C,
    });
    expect(r).toEqual({
      ok: false,
      message:
        "The odometer photo is required: take a photo of the odometer before you submit.",
    });
  });
  it("treats an empty reply as a failure", async () => {
    const { db } = fake({ data: [] });
    expect(
      (await submitInspection(db, { inspectionId: I, clientSubmissionId: C }))
        .ok,
    ).toBe(false);
  });
});

describe("getMyInspection", () => {
  const doc = {
    allocation_status: "pre_inspection_pending",
    stage: "pre_shift",
    vehicle: {
      fleet_number: "FL-001",
      registration: "TEST001-GP",
      make: "Make",
      model: "Model",
    },
    inspection: null,
    items: [
      {
        template_item_id: A,
        item_key: "tyres",
        question: "Tyres",
        response_type: "ok_defect",
        required: true,
        severity_rule: "safety_critical",
        sequence: 1,
        allow_na: false,
        answer: null,
      },
    ],
    photo_slots: [
      {
        kind: "odometer",
        template_item_id: null,
        required: true,
        filled: false,
      },
    ],
    odometer_photo_present: false,
    known_damage_reviewed: false,
    known_damage: [],
    new_damage: [],
  };
  it("parses the document", async () => {
    const { db, calls } = fake({ data: doc });
    const r = await getMyInspection(db, {
      allocationId: A,
      stage: "pre_shift",
    });
    expect(r.ok && r.inspection.items[0].item_key).toBe("tyres");
    expect(calls[0]).toEqual({
      name: "my_inspection",
      args: { p_allocation_id: A, p_stage: "pre_shift" },
    });
  });
  it("refuses a document that is not the expected shape rather than rendering it", async () => {
    const { db } = fake({ data: { items: "nope" } });
    expect(
      (await getMyInspection(db, { allocationId: A, stage: "pre_shift" })).ok,
    ).toBe(false);
  });
});

describe("listInspections", () => {
  it("maps rows and passes NULL for no branch filter and no limit", async () => {
    const row = {
      inspection_id: I,
      allocation_id: A,
      branch_id: A,
      branch_name: "Branch",
      shift_date: "2026-11-18",
      inspection_stage: "pre_shift",
      status: "submitted",
      vehicle_fleet_number: "FL-001",
      vehicle_registration: "TEST001-GP",
      started_at: "2026-11-18T04:00:00Z",
      submitted_at: "2026-11-18T04:20:00Z",
      late_flag: true,
      safety_defect_flag: true,
      captured_offline: false,
      completed_by_role: "driver",
      allocation_status: "in_use",
      device_flag: null,
      new_damage_flag: true,
      known_damage_reviewed: true,
    };
    const { db, calls } = fake({ data: [row] });
    const r = await listInspections(db, {
      from: "2026-11-18T00:00:00+02:00",
      to: "2026-11-19T00:00:00+02:00",
    });
    expect(r.ok && r.rows[0]).toMatchObject({
      id: I,
      lateFlag: true,
      safetyDefectFlag: true,
      fleetNumber: "FL-001",
      newDamageFlag: true,
    });
    expect(calls[0].args).toEqual({
      p_from: "2026-11-18T00:00:00+02:00",
      p_to: "2026-11-19T00:00:00+02:00",
      p_branch_id: null,
      p_limit: null,
    });
  });
  it("validates first (a reversed or malformed range is the database's job; a bad timestamp is ours)", async () => {
    const { db, calls } = fake();
    expect((await listInspections(db, { from: "x", to: "y" })).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("attachOdometerPhoto / attachDefectPhoto", () => {
  const F = "5eed0000-0000-4000-8000-000000000f01";
  const T = "5eed0000-0000-4000-8000-000000000c01";
  it("validate first: no call for a bad id", async () => {
    const { db, calls } = fake();
    expect(
      (
        await attachOdometerPhoto(db, {
          inspectionId: "x",
          evidenceFileId: F,
          clientSubmissionId: C,
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await attachDefectPhoto(db, {
          inspectionId: I,
          evidenceFileId: F,
          clientSubmissionId: C,
        })
      ).ok,
    ).toBe(false); // the item is required
    expect(calls).toHaveLength(0);
  });
  it("attach_odometer_photo gets the file and its own client_submission_id", async () => {
    const { db, calls } = fake({ data: "photo-1" });
    expect(
      await attachOdometerPhoto(db, {
        inspectionId: I,
        evidenceFileId: F,
        clientSubmissionId: C,
      }),
    ).toEqual({ ok: true, photoId: "photo-1" });
    expect(calls[0]).toEqual({
      name: "attach_odometer_photo",
      args: {
        p_inspection_id: I,
        p_evidence_file_id: F,
        p_client_submission_id: C,
      },
    });
  });
  it("a defect photo is linked to its checklist item", async () => {
    const { db, calls } = fake({ data: "photo-2" });
    await attachDefectPhoto(db, {
      inspectionId: I,
      evidenceFileId: F,
      templateItemId: T,
      clientSubmissionId: C,
    });
    expect(calls[0]!.name).toBe("attach_inspection_photo");
    expect(calls[0]!.args).toMatchObject({
      p_template_item_id: T,
      p_category: "damage",
    });
  });
  it("shows the database's refusal as is (DEC-04, IN010)", async () => {
    const { db } = fake({
      error: {
        code: "IN010",
        message:
          "Photos for an inspection must be taken with the in-app camera; gallery, file and imported images are not accepted.",
        hint: "user_message",
      },
    });
    const r = await attachOdometerPhoto(db, {
      inspectionId: I,
      evidenceFileId: F,
      clientSubmissionId: C,
    });
    expect(r).toEqual({
      ok: false,
      message:
        "Photos for an inspection must be taken with the in-app camera; gallery, file and imported images are not accepted.",
    });
  });
});
