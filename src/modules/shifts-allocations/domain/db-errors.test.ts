import { describe, expect, it } from "vitest";
import { shiftDbMessage } from "./db-errors";

describe("shiftDbMessage", () => {
  it.each([
    [
      "23505",
      "an active shift template with that name already exists at this branch",
      /name already exists/,
    ],
    [
      "42501",
      "missing permission allocation.manage for this branch",
      /not allowed/,
    ],
    ["P0002", "shift not found", /not found/],
    ["55000", "an archived shift template cannot be changed", /archived/],
    ["55000", "a cancelled shift cannot be changed", /cancelled/],
    [
      "55000",
      "a shift with active allocations cannot be cancelled",
      /active allocations/,
    ],
    ["22023", "at most 31 days can be generated in one call", /31 days/],
    [
      "22023",
      "a reason (1-500 characters) is required to cancel a shift",
      /reason is required/,
    ],
    ["PGRST301", "JWT expired", /session has expired/],
  ])("%s: %s", (code, message, expected) => {
    expect(shiftDbMessage({ code, message })).toMatch(expected);
  });
  it("never echoes SQL or constraint names", () => {
    const m = shiftDbMessage({
      code: "XX000",
      message:
        'duplicate key value violates unique constraint "shifts_template_date_scheduled_uq"',
    });
    expect(m).not.toMatch(/constraint|shifts_|duplicate key/i);
  });
});
