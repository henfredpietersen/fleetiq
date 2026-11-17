import { describe, expect, it } from "vitest";
import { vehicleDbMessage } from "./db-errors";
import { formatDateTime, statusLabel } from "./format";

describe("vehicleDbMessage", () => {
  it("names the duplicate that was hit, without leaking SQL", () => {
    expect(
      vehicleDbMessage({
        code: "23505",
        message:
          'duplicate key value violates unique constraint "vehicles_registration_uq"',
      }),
    ).toMatch(/registration number already exists/);
    expect(
      vehicleDbMessage({
        code: "23505",
        message: 'violates unique constraint "vehicles_fleet_number_uq"',
      }),
    ).toMatch(/fleet number already exists/);
    expect(
      vehicleDbMessage({
        code: "23505",
        message: 'violates unique constraint "vehicles_vin_uq"',
      }),
    ).toMatch(/VIN/);
    expect(
      vehicleDbMessage({
        code: "23505",
        message: 'violates unique constraint "approvals_one_pending_transfer"',
      }),
    ).toMatch(/already has a transfer request/);
    expect(vehicleDbMessage({ code: "23505", message: "x" })).not.toMatch(
      /constraint/,
    );
  });

  it("explains segregation of duties and permission denials", () => {
    expect(
      vehicleDbMessage({
        code: "42501",
        message:
          "segregation of duties (DEC-24): you cannot decide your own request",
      }),
    ).toMatch(/another fleet administrator/i);
    expect(
      vehicleDbMessage({
        code: "42501",
        message: "missing permission vehicle.manage",
      }),
    ).toBe("You are not allowed to do this.");
  });

  it("maps state errors and falls back safely", () => {
    expect(
      vehicleDbMessage({
        code: "55000",
        message: "an archived vehicle cannot be transferred",
      }),
    ).toMatch(/archived/);
    expect(
      vehicleDbMessage({
        code: "55000",
        message: "the vehicle has moved since this request",
      }),
    ).toMatch(/moved/);
    expect(
      vehicleDbMessage({
        code: "55000",
        message: "approval is already approved",
      }),
    ).toMatch(/already been decided/);
    expect(vehicleDbMessage({ code: "P0002", message: "x" })).toMatch(
      /not found/,
    );
    expect(
      vehicleDbMessage({
        code: "22023",
        message: "choose a different destination branch",
      }),
    ).toMatch(/destination/i);
    expect(
      vehicleDbMessage({
        code: "XX000",
        message: 'relation "secret" does not exist',
      }),
    ).toBe("Something went wrong on our side. Please try again.");
    expect(vehicleDbMessage({})).toMatch(/Something went wrong/);
  });
});

describe("format", () => {
  it("formats dates in the company timezone and tolerates bad input", () => {
    expect(formatDateTime(null)).toBe("—");
    expect(formatDateTime("not a date")).toBe("—");
    // 22:30 UTC is 00:30 the next day in Africa/Johannesburg (UTC+2)
    expect(formatDateTime("2026-11-17T22:30:00Z")).toMatch(/18/);
  });
  it("labels stored statuses and passes unknown ones through", () => {
    expect(statusLabel("in_maintenance")).toBe("In maintenance");
    expect(statusLabel("weird")).toBe("weird");
  });
});
