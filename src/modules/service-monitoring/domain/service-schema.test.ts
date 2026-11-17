import { describe, expect, it } from "vitest";
import {
  changeDefaultSchema,
  overrideRequestSchema,
  recordSchema,
  reverseSchema,
  verifySchema,
} from "./service-schema";

const U = "5eed0000-0000-4000-8000-000000000101";
const S = "5eed0000-0000-4000-8000-0000000000b1";
const values = {
  serviceIntervalKm: "15000",
  earlyToleranceKm: "1500",
  lateToleranceKm: "1500",
  reason: "Policy",
};

describe("changeDefaultSchema", () => {
  it("accepts the standard default without a time basis", () => {
    const r = changeDefaultSchema.safeParse(values);
    expect(r.success && r.data.serviceIntervalDays).toBeUndefined();
  });
  it("rejects tolerances at or above the interval and a zero interval", () => {
    expect(
      changeDefaultSchema.safeParse({ ...values, earlyToleranceKm: "15000" })
        .success,
    ).toBe(false);
    expect(
      changeDefaultSchema.safeParse({ ...values, lateToleranceKm: "20000" })
        .success,
    ).toBe(false);
    expect(
      changeDefaultSchema.safeParse({
        ...values,
        serviceIntervalKm: "0",
        earlyToleranceKm: "0",
        lateToleranceKm: "0",
      }).success,
    ).toBe(false);
  });
  it("needs interval days and BOTH tolerance days together (DEC-11: never assumed)", () => {
    expect(
      changeDefaultSchema.safeParse({ ...values, serviceIntervalDays: "180" })
        .success,
    ).toBe(false);
    expect(
      changeDefaultSchema.safeParse({
        ...values,
        serviceIntervalDays: "180",
        earlyToleranceDays: "30",
      }).success,
    ).toBe(false);
    expect(
      changeDefaultSchema.safeParse({
        ...values,
        serviceIntervalDays: "180",
        earlyToleranceDays: "30",
        lateToleranceDays: "30",
      }).success,
    ).toBe(true);
  });
  it("requires a reason and refuses decimals and negatives", () => {
    expect(
      changeDefaultSchema.safeParse({ ...values, reason: " " }).success,
    ).toBe(false);
    expect(
      changeDefaultSchema.safeParse({ ...values, serviceIntervalKm: "15000.5" })
        .success,
    ).toBe(false);
    expect(
      changeDefaultSchema.safeParse({ ...values, earlyToleranceKm: "-1" })
        .success,
    ).toBe(false);
  });
});

describe("overrideRequestSchema", () => {
  const base = { ...values, clientSubmissionId: U };
  it("each scope needs its own target and drops the others", () => {
    expect(
      overrideRequestSchema.safeParse({ ...base, scope: "vehicle" }).success,
    ).toBe(false);
    expect(
      overrideRequestSchema.safeParse({
        ...base,
        scope: "make_model",
        make: "Toyota",
      }).success,
    ).toBe(false);
    expect(
      overrideRequestSchema.safeParse({ ...base, scope: "category" }).success,
    ).toBe(false);
    const v = overrideRequestSchema.safeParse({
      ...base,
      scope: "vehicle",
      vehicleId: U,
      make: "x",
      vehicleCategory: "y",
    });
    expect(
      v.success && [v.data.vehicleId, v.data.make, v.data.vehicleCategory],
    ).toEqual([U, undefined, undefined]);
  });
  it("the company default is not an override", () => {
    expect(
      overrideRequestSchema.safeParse({ ...base, scope: "company_default" })
        .success,
    ).toBe(false);
  });
});

describe("recordSchema", () => {
  const base = {
    vehicleId: U,
    serviceDate: "2026-10-01",
    odometerKm: "82400",
    serviceType: "Scheduled service",
    clientSubmissionId: S,
  };
  it("accepts a normal record and defaults the source to workshop", () => {
    const r = recordSchema.safeParse(base);
    expect(r.success && r.data.source).toBe("workshop");
  });
  it("refuses historical_import here (reviewed import only), future and impossible dates, bad odometers", () => {
    expect(
      recordSchema.safeParse({ ...base, source: "historical_import" }).success,
    ).toBe(false);
    expect(
      recordSchema.safeParse({ ...base, serviceDate: "2999-01-01" }).success,
    ).toBe(false);
    expect(
      recordSchema.safeParse({ ...base, serviceDate: "2026-02-30" }).success,
    ).toBe(false);
    expect(recordSchema.safeParse({ ...base, odometerKm: "-1" }).success).toBe(
      false,
    );
    expect(
      recordSchema.safeParse({ ...base, odometerKm: "12.5" }).success,
    ).toBe(false);
  });
});

describe("verify / reverse", () => {
  it("rejecting needs a reason; verifying does not", () => {
    expect(
      verifySchema.safeParse({ recordId: U, decision: "rejected" }).success,
    ).toBe(false);
    expect(
      verifySchema.safeParse({ recordId: U, decision: "verified" }).success,
    ).toBe(true);
  });
  it("a reversal always needs a reason", () => {
    expect(reverseSchema.safeParse({ recordId: U, reason: "" }).success).toBe(
      false,
    );
    expect(
      reverseSchema.safeParse({ recordId: U, reason: "Wrong vehicle" }).success,
    ).toBe(true);
  });
});
