import { describe, expect, it } from "vitest";
import {
  boardFilterSchema,
  decideOverrideSchema,
  eligibilitySchema,
  parseInput,
  requestAllocationSchema,
  requiredLicenceCodeSchema,
} from "./allocation-schema";

const S = "5eed0000-0000-4000-8000-000000000901";
const V = "5eed0000-0000-4000-8000-000000000101";
const D = "5eed0000-0000-4000-8000-000000000301";
const C = "5eed0000-0000-4000-8000-000000000a01";

describe("requestAllocationSchema", () => {
  const ok = { shiftId: S, vehicleId: V, driverId: D, clientSubmissionId: C };
  it("accepts a request without a reason (planned times come from the shift)", () => {
    expect(parseInput(requestAllocationSchema, ok).ok).toBe(true);
  });
  it("trims the reason and treats a blank one as absent", () => {
    const a = parseInput(requestAllocationSchema, {
      ...ok,
      reason: "  Cover  ",
    });
    expect(a.ok && a.value.reason).toBe("Cover");
    const b = parseInput(requestAllocationSchema, { ...ok, reason: "   " });
    expect(b.ok && b.value.reason).toBeUndefined();
  });
  it("rejects bad ids, a missing submission id and an over-long reason", () => {
    expect(
      parseInput(requestAllocationSchema, { ...ok, shiftId: "x" }).ok,
    ).toBe(false);
    expect(
      parseInput(requestAllocationSchema, {
        ...ok,
        clientSubmissionId: undefined,
      }).ok,
    ).toBe(false);
    expect(
      parseInput(requestAllocationSchema, { ...ok, reason: "x".repeat(1001) })
        .ok,
    ).toBe(false);
  });
});

describe("eligibilitySchema / decideOverrideSchema / boardFilterSchema", () => {
  it("needs three valid ids", () => {
    expect(
      eligibilitySchema.safeParse({ shiftId: S, vehicleId: V, driverId: D })
        .success,
    ).toBe(true);
    expect(
      eligibilitySchema.safeParse({ shiftId: S, vehicleId: V }).success,
    ).toBe(false);
  });
  it("a decision is approved or rejected, notes optional", () => {
    expect(
      decideOverrideSchema.safeParse({ approvalId: C, decision: "approved" })
        .success,
    ).toBe(true);
    expect(
      decideOverrideSchema.safeParse({
        approvalId: C,
        decision: "rejected",
        notes: "No",
      }).success,
    ).toBe(true);
    expect(
      decideOverrideSchema.safeParse({ approvalId: C, decision: "cancelled" })
        .success,
    ).toBe(false);
    expect(decideOverrideSchema.safeParse({ approvalId: C }).success).toBe(
      false,
    );
  });
  it("the board filter tolerates blanks and rejects a bad date", () => {
    expect(
      boardFilterSchema.safeParse({ branchId: "", date: "" }).success,
    ).toBe(true);
    expect(boardFilterSchema.safeParse({ date: "2026-13-40" }).success).toBe(
      false,
    );
    expect(boardFilterSchema.safeParse({ date: "2026-12-01" }).success).toBe(
      true,
    );
  });
});

describe("requiredLicenceCodeSchema", () => {
  it("accepts each legal code, or blank to clear, with a reason", () => {
    for (const code of ["A1", "A", "B", "C1", "C", "EB", "EC1", "EC"])
      expect(
        requiredLicenceCodeSchema.safeParse({
          vehicleId: V,
          code,
          reason: "Papers",
        }).success,
      ).toBe(true);
    const cleared = requiredLicenceCodeSchema.safeParse({
      vehicleId: V,
      code: "",
      reason: "Papers",
    });
    expect(cleared.success && cleared.data.code).toBeUndefined();
  });
  it("rejects unknown or lower-case codes and a missing reason", () => {
    expect(
      requiredLicenceCodeSchema.safeParse({
        vehicleId: V,
        code: "D",
        reason: "x",
      }).success,
    ).toBe(false);
    expect(
      requiredLicenceCodeSchema.safeParse({
        vehicleId: V,
        code: "b",
        reason: "x",
      }).success,
    ).toBe(false);
    expect(
      requiredLicenceCodeSchema.safeParse({
        vehicleId: V,
        code: "B",
        reason: "  ",
      }).success,
    ).toBe(false);
  });
});
