import { describe, expect, it } from "vitest";
import {
  beginOnBehalfSchema,
  onboardingDamageSchema,
  reportDamageSchema,
  repairDamageSchema,
  reviewDamageSchema,
} from "./damage-schema";

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const base = {
  inspectionId: id(1),
  zone: "left_front",
  severity: "minor",
  description: "Scratch on the door",
  evidenceFileIds: [id(2)],
  clientSubmissionId: id(3),
};

describe("damage input", () => {
  it("accepts a complete report", () => {
    expect(reportDamageSchema.safeParse(base).success).toBe(true);
  });
  it("requires a known zone and severity", () => {
    expect(
      reportDamageSchema.safeParse({ ...base, zone: "nose" }).success,
    ).toBe(false);
    expect(
      reportDamageSchema.safeParse({ ...base, severity: "huge" }).success,
    ).toBe(false);
  });
  it("requires a description of 1 to 500 characters", () => {
    expect(
      reportDamageSchema.safeParse({ ...base, description: "  " }).success,
    ).toBe(false);
    expect(
      reportDamageSchema.safeParse({ ...base, description: "x".repeat(501) })
        .success,
    ).toBe(false);
    expect(
      reportDamageSchema.safeParse({ ...base, description: "x".repeat(500) })
        .success,
    ).toBe(true);
  });
  it("requires 1 to 10 different photos", () => {
    expect(
      reportDamageSchema.safeParse({ ...base, evidenceFileIds: [] }).success,
    ).toBe(false);
    expect(
      reportDamageSchema.safeParse({ ...base, evidenceFileIds: [id(2), id(2)] })
        .success,
    ).toBe(false);
    expect(
      reportDamageSchema.safeParse({
        ...base,
        evidenceFileIds: Array.from({ length: 11 }, (_, n) => id(10 + n)),
      }).success,
    ).toBe(false);
  });
  it("onboarding needs a vehicle and the same fields", () => {
    const { inspectionId: _i, ...rest } = base;
    void _i;
    expect(
      onboardingDamageSchema.safeParse({ ...rest, vehicleId: id(4) }).success,
    ).toBe(true);
    expect(onboardingDamageSchema.safeParse(rest).success).toBe(false);
  });
  it("a dispute needs a reason, a verification does not", () => {
    const r = { itemId: id(1), clientSubmissionId: id(2) };
    expect(
      reviewDamageSchema.safeParse({ ...r, decision: "verified" }).success,
    ).toBe(true);
    expect(
      reviewDamageSchema.safeParse({ ...r, decision: "disputed" }).success,
    ).toBe(false);
    expect(
      reviewDamageSchema.safeParse({
        ...r,
        decision: "disputed",
        reason: "Not damage",
      }).success,
    ).toBe(true);
    expect(
      reviewDamageSchema.safeParse({ ...r, decision: "maybe" }).success,
    ).toBe(false);
  });
  it("marking repaired needs a note; on-behalf needs a reason of 1-500 characters", () => {
    const r = { itemId: id(1), clientSubmissionId: id(2) };
    expect(repairDamageSchema.safeParse({ ...r, note: "" }).success).toBe(
      false,
    );
    expect(
      repairDamageSchema.safeParse({ ...r, note: "Repaired" }).success,
    ).toBe(true);
    const o = { allocationId: id(1), clientSubmissionId: id(2) };
    expect(beginOnBehalfSchema.safeParse({ ...o, reason: "" }).success).toBe(
      false,
    );
    expect(
      beginOnBehalfSchema.safeParse({ ...o, reason: "x".repeat(501) }).success,
    ).toBe(false);
    expect(
      beginOnBehalfSchema.safeParse({ ...o, reason: "Driver unwell" }).success,
    ).toBe(true);
  });
});
