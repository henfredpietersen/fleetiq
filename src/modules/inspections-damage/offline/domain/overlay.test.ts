import { describe, expect, it } from "vitest";
import type { MyInspection } from "../../domain/inspection-types";
import { applyQueue, isLocalInspectionId } from "./overlay";
import type { QueueItem } from "./types";

const server: MyInspection = {
  allocation_status: "pre_inspection_pending",
  stage: "pre_shift",
  vehicle: { fleet_number: "F1", registration: "R1", make: "M", model: "X" },
  inspection: null,
  items: [
    {
      template_item_id: "t1",
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
  photo_slots: [],
  odometer_photo_present: false,
  reading: null,
  known_damage_reviewed: false,
  known_damage: [],
  new_damage: [],
};
const SCOPE = "a1:pre_shift";
const it_ = (seq: number, payload: QueueItem["payload"]): QueueItem => ({
  id: `i${seq}`,
  profileId: "p",
  seq,
  scope: SCOPE,
  allocationId: "a1",
  stage: "pre_shift",
  kind: payload.kind,
  csid: `c${seq}`,
  payload,
  deviceTime: "2026-11-25T08:00:00.000Z",
  createdAt: 0,
  capturedOffline: true,
  attempts: 0,
  nextAttemptAt: 0,
});
const photo = {
  blobId: "b",
  size: 1,
  width: 1,
  height: 1,
  capturedAt: "x",
  location: null,
  capturedOffline: true,
};

describe("the inspection with the unsent queue applied", () => {
  it("nothing queued: the server's data as it is", () => {
    const o = applyQueue(server, [], SCOPE);
    expect(o.data).toEqual(server);
    expect(o.waiting).toBe(0);
  });
  it("a queued begin shows a local draft that the form can work on", () => {
    const o = applyQueue(server, [it_(1, { kind: "begin" })], SCOPE);
    expect(isLocalInspectionId(o.data.inspection!.id)).toBe(true);
    expect(o.data.inspection).toMatchObject({
      status: "draft",
      captured_offline: true,
    });
    expect(o.beginQueued).toBe(true);
  });
  it("the last queued save shows its answers and the vehicle confirmation", () => {
    const o = applyQueue(
      server,
      [
        it_(1, { kind: "begin" }),
        it_(2, {
          kind: "save",
          responses: [{ templateItemId: "t1", value: "ok" }],
          vehicleConfirmed: true,
        }),
        it_(3, {
          kind: "save",
          responses: [
            { templateItemId: "t1", value: "defect", comment: "Cut" },
          ],
          vehicleConfirmed: true,
        }),
      ],
      SCOPE,
    );
    expect(o.data.items[0]!.answer).toEqual({
      value: "defect",
      comment: "Cut",
    });
    expect(o.data.inspection!.vehicle_confirmed).toBe(true);
  });
  it("known-damage confirmation, photos, damage reports and submit are visible as waiting", () => {
    const o = applyQueue(
      server,
      [
        it_(1, { kind: "begin" }),
        it_(2, { kind: "confirm_known" }),
        it_(3, {
          kind: "photo",
          target: { kind: "odometer" },
          photo,
          attachCsid: "x",
        }),
        it_(4, {
          kind: "photo",
          target: { kind: "defect", templateItemId: "t1" },
          photo,
          attachCsid: "y",
        }),
        it_(5, {
          kind: "report_damage",
          zone: "roof",
          severity: "minor",
          description: "Dent",
          photos: [],
        }),
        it_(6, { kind: "submit" }),
      ],
      SCOPE,
    );
    expect(o.data.known_damage_reviewed).toBe(true);
    expect(o.odometerQueued).toBe(true);
    expect([...o.defectPhotosQueued]).toEqual(["t1"]);
    expect(o.damageQueued[0]).toMatchObject({
      zoneLabel: "Roof",
      description: "Dent",
    });
    expect(o.submitQueued).toBe(true);
    expect(o.waiting).toBe(6);
  });
  it("items of another inspection are ignored", () => {
    const other = { ...it_(1, { kind: "begin" }), scope: "a2:pre_shift" };
    expect(applyQueue(server, [other], SCOPE).beginQueued).toBe(false);
  });
});

import { effectiveAllocation } from "./overlay";
describe("the allocation with unsent inspections applied", () => {
  const a = {
    id: "a1",
    status: "pre_inspection_pending",
    postShiftSubmitted: false,
  };
  it("a queued pre-shift submit shows the allocation as in use, marked unsent", () => {
    expect(
      effectiveAllocation(a, [
        it_(1, { kind: "begin" }),
        it_(2, { kind: "submit" }),
      ]),
    ).toEqual({
      status: "in_use",
      postShiftSubmitted: false,
      unsent: true,
    });
  });
  it("a queued post-shift inspection moves it on; a submit marks it awaiting closure", () => {
    const post = (seq: number, payload: QueueItem["payload"]) => ({
      ...it_(seq, payload),
      scope: "a1:post_shift",
      stage: "post_shift" as const,
    });
    const inUse = { id: "a1", status: "in_use", postShiftSubmitted: false };
    expect(
      effectiveAllocation(inUse, [post(1, { kind: "begin" })]).status,
    ).toBe("post_inspection_pending");
    expect(
      effectiveAllocation(inUse, [
        post(1, { kind: "begin" }),
        post(2, { kind: "submit" }),
      ]),
    ).toMatchObject({
      status: "post_inspection_pending",
      postShiftSubmitted: true,
    });
  });
  it("nothing queued: unchanged and not unsent", () => {
    expect(effectiveAllocation(a, [])).toEqual({
      status: a.status,
      postShiftSubmitted: false,
      unsent: false,
    });
  });
});
