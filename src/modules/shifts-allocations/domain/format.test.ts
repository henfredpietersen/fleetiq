import { describe, expect, it } from "vitest";
import {
  formatClock,
  formatShiftWindow,
  fromLocalInput,
  toLocalInput,
} from "./format";
import { shiftTimes } from "./shift-times";

describe("shift formatting", () => {
  it("drops seconds from Postgres time values", () => {
    expect(formatClock("06:00:00")).toBe("06:00");
  });
  it("shows a day shift in local time", () => {
    const t = shiftTimes("2026-12-01", "06:00", "18:00");
    expect(formatShiftWindow(t.scheduledStartAt, t.scheduledEndAt)).toBe(
      "06:00–18:00",
    );
  });
  it("marks a shift that ends the next local day", () => {
    const t = shiftTimes("2026-12-31", "18:00", "06:00");
    expect(formatShiftWindow(t.scheduledStartAt, t.scheduledEndAt)).toBe(
      "18:00–06:00 (+1 day)",
    );
    const u = shiftTimes("2026-12-31", "22:00", "00:30");
    expect(formatShiftWindow(u.scheduledStartAt, u.scheduledEndAt)).toBe(
      "22:00–00:30 (+1 day)",
    );
  });
});

describe("local datetime inputs (Africa/Johannesburg)", () => {
  it("round-trips", () => {
    expect(toLocalInput("2026-11-18T04:00:00Z")).toBe("2026-11-18T06:00");
    expect(fromLocalInput("2026-11-18T06:00")).toBe(
      "2026-11-18T06:00:00+02:00",
    );
    expect(new Date(fromLocalInput("2026-11-18T06:00")!).toISOString()).toBe(
      "2026-11-18T04:00:00.000Z",
    );
  });
  it("rejects malformed input", () => {
    expect(fromLocalInput("18/11/2026")).toBeNull();
  });
});
