import { describe, expect, it } from "vitest";
import {
  createDriverSchema,
  driverStatusSchema,
  licenceSchema,
  verifyLicenceSchema,
} from "./driver-schema";

const ID = "11111111-1111-4111-8111-111111111111";
const base = {
  driverId: ID,
  licenceNumber: " SYN0000001 ",
  licenceCode: "eb",
  issueDate: "2022-01-10",
  expiryDate: "2027-01-10",
  prdpRequired: "",
  clientSubmissionId: ID,
};

describe("createDriverSchema", () => {
  const ok = {
    branchId: ID,
    employeeNumber: " t0001 ",
    displayName: " Synthetic Driver ",
    phone: "",
  };

  it("normalises the employee number to its canonical form and trims the name", () => {
    const r = createDriverSchema.safeParse(ok);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.employeeNumber).toBe("T0001");
      expect(r.data.displayName).toBe("Synthetic Driver");
      expect(r.data.phone).toBeUndefined();
    }
  });

  it("rejects employee numbers the database would refuse", () => {
    for (const bad of ["", "has space", "ünï", "-LEADING", "A".repeat(21)]) {
      expect(
        createDriverSchema.safeParse({ ...ok, employeeNumber: bad }).success,
        bad,
      ).toBe(false);
    }
  });

  it("requires a branch and a name", () => {
    expect(
      createDriverSchema.safeParse({ ...ok, branchId: "nope" }).success,
    ).toBe(false);
    expect(
      createDriverSchema.safeParse({ ...ok, displayName: "  " }).success,
    ).toBe(false);
  });
});

describe("licenceSchema", () => {
  it("accepts a valid licence and normalises number/code", () => {
    const r = licenceSchema.safeParse(base);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.licenceNumber).toBe("SYN0000001");
      expect(r.data.licenceCode).toBe("EB");
      expect(r.data.prdpRequired).toBe(false);
      expect(r.data.evidenceFileId).toBeUndefined();
    }
  });

  it("expiry must be after issue (equal is rejected)", () => {
    expect(
      licenceSchema.safeParse({ ...base, expiryDate: "2022-01-10" }).success,
    ).toBe(false);
    expect(
      licenceSchema.safeParse({ ...base, expiryDate: "2021-01-10" }).success,
    ).toBe(false);
  });

  it("PrDP expiry is required when a PrDP is required, and not otherwise", () => {
    expect(
      licenceSchema.safeParse({ ...base, prdpRequired: "on" }).success,
    ).toBe(false);
    expect(
      licenceSchema.safeParse({
        ...base,
        prdpRequired: "on",
        prdpExpiryDate: "2027-06-01",
      }).success,
    ).toBe(true);
    expect(
      licenceSchema.safeParse({ ...base, prdpRequired: "", prdpExpiryDate: "" })
        .success,
    ).toBe(true);
  });

  it("rejects impossible dates and a missing client submission id", () => {
    expect(
      licenceSchema.safeParse({ ...base, issueDate: "2022-13-40" }).success,
    ).toBe(false);
    expect(
      licenceSchema.safeParse({ ...base, clientSubmissionId: undefined })
        .success,
    ).toBe(false);
  });
});

describe("driverStatusSchema / verifyLicenceSchema", () => {
  it("a reason is mandatory to deactivate or reactivate", () => {
    expect(
      driverStatusSchema.safeParse({
        driverId: ID,
        status: "inactive",
        reason: " ",
      }).success,
    ).toBe(false);
    expect(
      driverStatusSchema.safeParse({
        driverId: ID,
        status: "deleted",
        reason: "x",
      }).success,
    ).toBe(false);
    expect(
      driverStatusSchema.safeParse({
        driverId: ID,
        status: "inactive",
        reason: "Left the company",
      }).success,
    ).toBe(true);
  });

  it("rejecting a licence record needs a reason; verifying does not", () => {
    const v = { licenceId: ID, driverId: ID };
    expect(
      verifyLicenceSchema.safeParse({ ...v, decision: "rejected" }).success,
    ).toBe(false);
    expect(
      verifyLicenceSchema.safeParse({
        ...v,
        decision: "rejected",
        reason: "Photo unreadable",
      }).success,
    ).toBe(true);
    expect(
      verifyLicenceSchema.safeParse({ ...v, decision: "verified" }).success,
    ).toBe(true);
  });
});
