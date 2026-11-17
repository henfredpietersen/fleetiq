import { describe, expect, it } from "vitest";
import {
  archiveSchema,
  createVehicleSchema,
  decisionSchema,
  formToObject,
  parseFilters,
  parseInput,
  transferRequestSchema,
  updateVehicleSchema,
} from "./vehicle-schema";

const A = "5eed0000-0000-4000-8000-0000000000b1";
const B = "5eed0000-0000-4000-8000-0000000000b2";
const base = {
  branchId: A,
  fleetNumber: "FL-001",
  registrationNumber: "test001-gp",
  make: "Toyota",
  model: "Hilux",
  vehicleCategory: "bakkie",
};

describe("createVehicleSchema", () => {
  it("normalises and defaults a minimal valid vehicle", () => {
    const r = parseInput(createVehicleSchema, base);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.registrationNumber).toBe("TEST001-GP"); // upper-cased like the DB CHECK
    expect(r.value.administrativeStatus).toBe("available");
    expect(r.value.vin).toBeUndefined();
    expect(r.value.modelYear).toBeUndefined();
  });

  it("treats blank optional fields as absent and upper-cases the VIN", () => {
    const r = parseInput(createVehicleSchema, {
      ...base,
      variant: "  ",
      modelYear: "",
      vin: " testvin0000000001 ",
      engineNumber: "",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.variant).toBeUndefined();
    expect(r.value.modelYear).toBeUndefined();
    expect(r.value.vin).toBe("TESTVIN0000000001");
  });

  it("coerces the model year from form text", () => {
    const r = parseInput(createVehicleSchema, { ...base, modelYear: "2021" });
    expect(r.ok && r.value.modelYear).toBe(2021);
  });

  it.each([
    ["missing registration", { registrationNumber: "" }],
    ["missing fleet number", { fleetNumber: "   " }],
    ["missing make", { make: undefined }],
    ["registration too long", { registrationNumber: "X".repeat(21) }],
    ["model year too old", { modelYear: "1800" }],
    ["model year too new", { modelYear: "2200" }],
    ["model year fractional", { modelYear: "2020.5" }],
    ["model year text", { modelYear: "abcd" }],
    ["VIN too short", { vin: "ABC" }],
    [
      "derived status 'allocated' is not storable",
      { administrativeStatus: "allocated" },
    ],
    ["unknown status", { administrativeStatus: "gone" }],
    ["branch is not a uuid", { branchId: "not-a-uuid" }],
  ])("rejects: %s", (_label, patch) => {
    const r = parseInput(createVehicleSchema, { ...base, ...patch });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.details?.length).toBeGreaterThan(0);
  });

  it("accepts every stored administrative status (DB §20)", () => {
    for (const s of [
      "available",
      "in_maintenance",
      "out_of_service",
      "retired",
    ])
      expect(
        parseInput(createVehicleSchema, { ...base, administrativeStatus: s })
          .ok,
      ).toBe(true);
  });

  it("does not let a client supply cache fields", () => {
    const r = parseInput(createVehicleSchema, {
      ...base,
      currentBranchId: B,
      currentOdometerKm: "99999",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).not.toHaveProperty("currentBranchId");
      expect(r.value).not.toHaveProperty("currentOdometerKm");
    }
  });
});

describe("updateVehicleSchema", () => {
  it("needs the vehicle id and ignores a branch change", () => {
    const { branchId: _unused, ...rest } = base;
    void _unused;
    expect(parseInput(updateVehicleSchema, rest).ok).toBe(false);
    const r = parseInput(updateVehicleSchema, {
      ...rest,
      id: A,
      branchId: B,
      administrativeStatus: "available",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).not.toHaveProperty("branchId");
  });
});

describe("updateVehicleSchema status", () => {
  it("never defaults the status on edit (a missing field must not reset it)", () => {
    const { branchId: _b, ...rest } = base;
    void _b;
    expect(parseInput(updateVehicleSchema, { ...rest, id: A }).ok).toBe(false);
  });
});

describe("transferRequestSchema", () => {
  const ok = {
    vehicleId: A,
    toBranchId: B,
    reason: " Rebalancing ",
    clientSubmissionId: A,
  };
  it("trims the reason and requires every field", () => {
    const r = parseInput(transferRequestSchema, ok);
    expect(r.ok && r.value.reason).toBe("Rebalancing");
    for (const k of ["vehicleId", "toBranchId", "reason", "clientSubmissionId"])
      expect(parseInput(transferRequestSchema, { ...ok, [k]: "" }).ok).toBe(
        false,
      );
  });
  it("rejects a blank or oversized reason", () => {
    expect(parseInput(transferRequestSchema, { ...ok, reason: "   " }).ok).toBe(
      false,
    );
    expect(
      parseInput(transferRequestSchema, { ...ok, reason: "x".repeat(1001) }).ok,
    ).toBe(false);
  });
});

describe("decisionSchema / archiveSchema", () => {
  it("only approved or rejected", () => {
    expect(
      parseInput(decisionSchema, { approvalId: A, decision: "approved" }).ok,
    ).toBe(true);
    expect(
      parseInput(decisionSchema, {
        approvalId: A,
        decision: "rejected",
        notes: "no",
      }).ok,
    ).toBe(true);
    expect(
      parseInput(decisionSchema, { approvalId: A, decision: "cancelled" }).ok,
    ).toBe(false);
    expect(parseInput(decisionSchema, { approvalId: A }).ok).toBe(false);
  });
  it("archive flag parses from form text only", () => {
    const r = parseInput(archiveSchema, { id: A, archived: "true" });
    expect(r.ok && r.value.archived).toBe(true);
    expect(parseInput(archiveSchema, { id: A, archived: "yes" }).ok).toBe(
      false,
    );
  });
});

describe("parseFilters", () => {
  it("defaults to active vehicles and ignores junk", () => {
    expect(parseFilters({})).toMatchObject({ archived: "active" });
    const f = parseFilters({ branch: "nope", status: "bogus", archived: "x" });
    expect(f.branchId).toBeUndefined();
    expect(f.status).toBeUndefined();
    expect(f.archived).toBe("active");
  });
  it("strips characters that would break a PostgREST or() filter", () => {
    const f = parseFilters({ q: 'a,b)(c*%"d\\e' });
    expect(f.q).not.toMatch(/[,()*%"\\]/);
  });
  it("accepts valid filters", () => {
    expect(
      parseFilters({
        branch: A,
        status: "retired",
        archived: "all",
        q: "hilux",
      }),
    ).toEqual({
      q: "hilux",
      branchId: A,
      status: "retired",
      archived: "all",
    });
  });
});

describe("formToObject", () => {
  it("keeps strings and drops files", () => {
    const f = new FormData();
    f.set("a", "1");
    f.set("file", new Blob(["x"]), "x.txt");
    expect(formToObject(f)).toEqual({ a: "1" });
  });
});
