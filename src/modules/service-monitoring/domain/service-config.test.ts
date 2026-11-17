import { describe, expect, it } from "vitest";
import {
  NoServiceConfigError,
  resolveServiceConfig,
  type ServiceConfig,
  type ServiceScope,
  type VehicleRef,
} from "./service-config";

// The same cases are asserted in supabase/tests/database/phase2c_service_baseline.test.sql (resolve_service_config).
const hilux: VehicleRef = {
  id: "v1",
  make: "Toyota",
  model: "Hilux",
  vehicleCategory: "bakkie",
};
const ranger: VehicleRef = {
  id: "v2",
  make: "Ford",
  model: "Ranger",
  vehicleCategory: "bakkie",
};
const panelVan: VehicleRef = {
  id: "v3",
  make: "Isuzu",
  model: "D-Max",
  vehicleCategory: "panel van",
};

let n = 0;
function cfg(
  scope: ServiceScope,
  km: number,
  over: Partial<ServiceConfig> = {},
): ServiceConfig {
  return {
    id: `c${++n}`,
    scope,
    vehicleId: null,
    make: null,
    model: null,
    vehicleCategory: null,
    serviceIntervalKm: km,
    earlyToleranceKm: 100,
    lateToleranceKm: 100,
    serviceIntervalDays: null,
    earlyToleranceDays: null,
    lateToleranceDays: null,
    effectiveFrom: "1970-01-01T00:00:00Z",
    effectiveTo: null,
    ...over,
  };
}
const now = new Date("2026-11-17T10:00:00Z");
const def = cfg("company_default", 15000);
const category = cfg("category", 12000, { vehicleCategory: "bakkie" });
const makeModel = cfg("make_model", 13000, { make: "toyota", model: "HILUX" });
const vehicle = cfg("vehicle", 11000, { vehicleId: "v1" });
const all = [def, category, makeModel, vehicle];

describe("resolveServiceConfig precedence (DEC-19)", () => {
  it("level 4: company default", () => {
    expect(resolveServiceConfig(panelVan, all, now).scope).toBe(
      "company_default",
    );
  });
  it("level 3: category beats the default", () => {
    expect(resolveServiceConfig(ranger, all, now).scope).toBe("category");
  });
  it("level 2: make and model beat category (case-insensitive)", () => {
    expect(
      resolveServiceConfig(hilux, [def, category, makeModel], now).scope,
    ).toBe("make_model");
  });
  it("level 1: vehicle beats everything", () => {
    expect(resolveServiceConfig(hilux, all, now).serviceIntervalKm).toBe(11000);
  });
  it("another vehicle's override does not apply", () => {
    expect(
      resolveServiceConfig({ ...hilux, id: "other" }, all, now).scope,
    ).toBe("make_model");
  });
  it("returns exactly one configuration", () => {
    expect(resolveServiceConfig(hilux, all, now)).toBe(vehicle);
  });
});

describe("effective dates", () => {
  const old = cfg("vehicle", 11000, {
    vehicleId: "v1",
    effectiveTo: "2026-06-01T00:00:00Z",
  });
  const next = cfg("vehicle", 9000, {
    vehicleId: "v1",
    effectiveFrom: "2026-06-01T00:00:00Z",
  });
  const history = [def, old, next];
  it("before the change the old row applied", () => {
    expect(
      resolveServiceConfig(hilux, history, new Date("2026-05-31T23:59:59.999Z"))
        .serviceIntervalKm,
    ).toBe(11000);
  });
  it("range is [from, to): the change instant belongs to the new row", () => {
    expect(
      resolveServiceConfig(hilux, history, new Date("2026-06-01T00:00:00Z"))
        .serviceIntervalKm,
    ).toBe(9000);
  });
  it("after the change the new row applies (mid-cycle change)", () => {
    expect(resolveServiceConfig(hilux, history, now).serviceIntervalKm).toBe(
      9000,
    );
  });
  it("a row that has not started yet is ignored, falling back to the next level", () => {
    const future = cfg("vehicle", 5000, {
      vehicleId: "v1",
      effectiveFrom: "2027-01-01T00:00:00Z",
    });
    expect(resolveServiceConfig(hilux, [def, future], now).scope).toBe(
      "company_default",
    );
  });
});

describe("errors", () => {
  it("throws a clear error when nothing applies", () => {
    expect(() => resolveServiceConfig(hilux, [], now)).toThrow(
      NoServiceConfigError,
    );
    expect(() => resolveServiceConfig(hilux, [], now)).toThrow(
      /no service configuration applies to vehicle v1/,
    );
  });
  it("rejects an invalid time", () => {
    expect(() => resolveServiceConfig(hilux, all, new Date("nope"))).toThrow(
      RangeError,
    );
  });
});
