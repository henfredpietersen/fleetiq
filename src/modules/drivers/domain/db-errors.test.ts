import { describe, expect, it } from "vitest";
import { driverDbMessage } from "./db-errors";

describe("driverDbMessage", () => {
  it("explains the DEC-24 refusals without leaking SQL", () => {
    expect(
      driverDbMessage({
        code: "42501",
        message: "nobody verifies a record they created (DEC-24)",
      }),
    ).toMatch(/Another administrator/);
    expect(
      driverDbMessage({
        code: "42501",
        message: "nobody verifies their own licence (DEC-24)",
      }),
    ).toMatch(/your own licence/);
    expect(
      driverDbMessage({
        code: "42501",
        message: "missing permission driver.manage for this branch",
      }),
    ).toBe("You are not allowed to do this.");
  });

  it("maps constraint and trigger refusals", () => {
    expect(
      driverDbMessage({
        code: "23505",
        message:
          'duplicate key value violates unique constraint "driver_licences_evidence_file_id_uq"',
      }),
    ).toMatch(/already attached/);
    expect(
      driverDbMessage({
        code: "23505",
        message: 'violates unique constraint "driver_licences_no_duplicate"',
      }),
    ).toMatch(/already recorded/);
    expect(
      driverDbMessage({
        code: "23514",
        message:
          "evidence file must be licence evidence of the same company and the driver's branch",
      }),
    ).toMatch(/not licence evidence/);
    expect(
      driverDbMessage({
        code: "23514",
        message: 'violates check constraint "driver_licences_dates"',
      }),
    ).toMatch(/dates/);
    expect(driverDbMessage({ code: "55000" })).toMatch(/already been decided/);
  });

  it("never echoes internals for unknown errors", () => {
    const m = driverDbMessage({
      code: "XX000",
      message: 'relation "driver_licences" secret SELECT licence_number',
    });
    expect(m).toBe("Something went wrong on our side. Please try again.");
    expect(m).not.toMatch(/licence_number|SELECT/);
  });
});
