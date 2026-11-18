import { describe, expect, it } from "vitest";
import { allocationDbMessage } from "./allocation-errors";

const m = (code: string, message = "") =>
  allocationDbMessage({ code, message });

describe("allocationDbMessage", () => {
  it("overlaps name the vehicle or the driver", () => {
    expect(m("23P01", "vehicle already allocated during that period")).toMatch(
      /vehicle is already allocated/,
    );
    expect(m("23P01", "driver already allocated during that period")).toMatch(
      /driver is already allocated/,
    );
  });
  it("segregation of duties", () => {
    expect(
      m(
        "42501",
        "segregation of duties (DEC-24): the driver cannot approve their own licence override",
      ),
    ).toMatch(/driver cannot approve/);
    expect(
      m(
        "42501",
        "segregation of duties (DEC-24): you cannot decide your own request",
      ),
    ).toMatch(/cannot decide your own/);
    expect(
      m("42501", "missing permission allocation.manage for this branch"),
    ).toMatch(/not allowed/);
  });
  it("licence, availability and decided states", () => {
    expect(m("23514", "no eligible licence: the driver needs")).toMatch(
      /cannot be overridden/,
    );
    expect(m("55000", "the vehicle is not available (in maintenance")).toMatch(
      /not available/,
    );
    expect(m("55000", "the shift is not scheduled (it was cancelled)")).toMatch(
      /cancelled/,
    );
    expect(m("55000", "approval is already approved")).toMatch(
      /already been decided/,
    );
    expect(
      m(
        "55000",
        "a licence override for this vehicle, driver and shift is already waiting for approval",
      ),
    ).toMatch(/already waiting/);
    expect(
      m(
        "22023",
        "a reason (1-1000 characters) is required to request a licence override",
      ),
    ).toMatch(/reason is required/);
  });
  it("never echoes SQL or constraint names", () => {
    const text = m(
      "XX000",
      'violates exclusion constraint "va_vehicle_no_overlap"',
    );
    expect(text).not.toMatch(/va_vehicle|constraint/);
    expect(m("PGRST301")).toMatch(/session/);
  });
});
