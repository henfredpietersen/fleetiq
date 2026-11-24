import { describe, expect, it } from "vitest";
import {
  beginSchema,
  listInspectionsSchema,
  parseInput,
  saveSchema,
  submitSchema,
} from "./inspection-schema";
import { inspectionDbMessage } from "./inspection-errors";

const U = "5eed0000-0000-4000-8000-000000000901";
const C = "5eed0000-0000-4000-8000-000000000a01";

describe("inspection input schemas (zod before the database)", () => {
  it("begin: a valid request passes; a bad stage, id or time fails; offline defaults to false", () => {
    const ok = parseInput(beginSchema, {
      allocationId: U,
      stage: "pre_shift",
      clientSubmissionId: C,
    });
    expect(ok.ok && ok.value.capturedOffline).toBe(false);
    expect(
      parseInput(beginSchema, {
        allocationId: U,
        stage: "mid_shift",
        clientSubmissionId: C,
      }).ok,
    ).toBe(false);
    expect(
      parseInput(beginSchema, {
        allocationId: "x",
        stage: "pre_shift",
        clientSubmissionId: C,
      }).ok,
    ).toBe(false);
    expect(
      parseInput(beginSchema, {
        allocationId: U,
        stage: "pre_shift",
        clientSubmissionId: C,
        deviceStartedAt: "yesterday",
      }).ok,
    ).toBe(false);
    expect(
      parseInput(beginSchema, {
        allocationId: U,
        stage: "pre_shift",
        clientSubmissionId: C,
        deviceStartedAt: "2026-11-18T05:00:00+02:00",
        capturedOffline: true,
      }).ok,
    ).toBe(true);
  });
  it("save: answers need a question id and a value; comments are trimmed, blanks dropped, capped at 1000", () => {
    const base = { inspectionId: U, clientSubmissionId: C };
    const ok = parseInput(saveSchema, {
      ...base,
      responses: [
        { templateItemId: U, value: "defect", comment: "  Cut  " },
        { templateItemId: U, value: "ok", comment: "   " },
      ],
    });
    expect(ok.ok && ok.value.responses.map((r) => r.comment)).toEqual([
      "Cut",
      undefined,
    ]);
    expect(
      parseInput(saveSchema, {
        ...base,
        responses: [{ templateItemId: "x", value: "ok" }],
      }).ok,
    ).toBe(false);
    expect(
      parseInput(saveSchema, {
        ...base,
        responses: [{ templateItemId: U, value: "" }],
      }).ok,
    ).toBe(false);
    expect(
      parseInput(saveSchema, {
        ...base,
        responses: [
          { templateItemId: U, value: "defect", comment: "x".repeat(1001) },
        ],
      }).ok,
    ).toBe(false);
    expect(
      parseInput(saveSchema, {
        ...base,
        responses: Array.from({ length: 101 }, () => ({
          templateItemId: U,
          value: "ok",
        })),
      }).ok,
    ).toBe(false);
  });
  it("submit: needs the inspection id and a client submission id", () => {
    expect(
      parseInput(submitSchema, { inspectionId: U, clientSubmissionId: C }).ok,
    ).toBe(true);
    expect(parseInput(submitSchema, { inspectionId: U }).ok).toBe(false);
  });
  it("list: both ends are required timestamps; the limit is capped at 500", () => {
    const r = {
      from: "2026-11-18T00:00:00+02:00",
      to: "2026-11-19T00:00:00+02:00",
    };
    expect(parseInput(listInspectionsSchema, r).ok).toBe(true);
    expect(parseInput(listInspectionsSchema, { ...r, limit: 501 }).ok).toBe(
      false,
    );
    expect(parseInput(listInspectionsSchema, { from: "x", to: r.to }).ok).toBe(
      false,
    );
  });
});

describe("inspectionDbMessage", () => {
  it("shows the database's own message when it is marked for the user", () => {
    expect(
      inspectionDbMessage({
        code: "IN006",
        message: "The odometer photo is required",
        hint: "user_message",
      }),
    ).toBe("The odometer photo is required");
  });
  it("never echoes SQL text for anything else", () => {
    const m = inspectionDbMessage({
      code: "XX000",
      message: 'relation "inspections" does not exist',
    });
    expect(m).not.toMatch(/relation|inspections/);
    expect(inspectionDbMessage({ code: "42501", message: "x" })).toMatch(
      /not allowed/,
    );
    expect(inspectionDbMessage({ code: "PGRST301", message: "x" })).toMatch(
      /session has expired/,
    );
  });
});
