import { describe, expect, it } from "vitest";
import {
  crossesMidnight,
  inclusiveDays,
  localDate,
  shiftTimes,
} from "./shift-times";

// The same cases are asserted against public.shift_times() in supabase/tests/database/phase3a_shifts.test.sql.
describe("shiftTimes (mirror of the SQL shift_times)", () => {
  it("day shift 06:00-18:00 on 2026-12-01 (SAST = UTC+2)", () => {
    expect(shiftTimes("2026-12-01", "06:00", "18:00")).toEqual({
      scheduledStartAt: "2026-12-01T04:00:00.000Z",
      scheduledEndAt: "2026-12-01T16:00:00.000Z",
    });
  });
  it("night shift 18:00-06:00 ends the next day", () => {
    expect(shiftTimes("2026-12-01", "18:00", "06:00")).toEqual({
      scheduledStartAt: "2026-12-01T16:00:00.000Z",
      scheduledEndAt: "2026-12-02T04:00:00.000Z",
    });
  });
  it("night shift on 2026-12-31 ends 2027-01-01 06:00 local (across the year end)", () => {
    const r = shiftTimes("2026-12-31", "18:00", "06:00");
    expect(r.scheduledEndAt).toBe("2027-01-01T04:00:00.000Z");
    const local = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Africa/Johannesburg",
      dateStyle: "short",
      timeStyle: "short",
      hourCycle: "h23",
    }).format(new Date(r.scheduledEndAt));
    expect(local).toBe("2027-01-01, 06:00");
  });
  it("22:00-00:30 ends 00:30 on the next day", () => {
    expect(shiftTimes("2026-12-31", "22:00", "00:30")).toEqual({
      scheduledStartAt: "2026-12-31T20:00:00.000Z",
      scheduledEndAt: "2026-12-31T22:30:00.000Z",
    });
  });
  it("a start between 00:00 and 02:00 local falls on the previous UTC day", () => {
    expect(shiftTimes("2027-01-01", "00:30", "08:00").scheduledStartAt).toBe(
      "2026-12-31T22:30:00.000Z",
    );
  });
  it("the local start date of the result is the date asked for", () => {
    for (const [d, s, e] of [
      ["2026-12-01", "06:00", "18:00"],
      ["2026-12-31", "18:00", "06:00"],
      ["2027-01-01", "00:00", "08:00"],
      ["2026-03-01", "01:30", "02:30"],
    ] as const)
      expect(localDate(shiftTimes(d, s, e).scheduledStartAt)).toBe(d);
  });
  it("end is always after start", () => {
    for (const [s, e] of [
      ["06:00", "18:00"],
      ["18:00", "06:00"],
      ["22:00", "00:30"],
      ["23:59", "00:00"],
    ] as const) {
      const r = shiftTimes("2026-06-15", s, e);
      expect(Date.parse(r.scheduledEndAt)).toBeGreaterThan(
        Date.parse(r.scheduledStartAt),
      );
    }
  });
  it("refuses equal start and end, bad times and bad dates", () => {
    expect(() => shiftTimes("2026-12-01", "06:00", "06:00")).toThrow(
      RangeError,
    );
    expect(() => shiftTimes("2026-12-01", "24:00", "06:00")).toThrow(
      RangeError,
    );
    expect(() => shiftTimes("2026-12-01", "6:00", "18:00")).toThrow(RangeError);
    expect(() => shiftTimes("2026-02-30", "06:00", "18:00")).toThrow(
      RangeError,
    );
    expect(() => shiftTimes("12/01/2026", "06:00", "18:00")).toThrow(
      RangeError,
    );
  });
  it("accepts seconds like Postgres time values", () => {
    expect(shiftTimes("2026-12-01", "06:00:00", "18:00:00")).toEqual(
      shiftTimes("2026-12-01", "06:00", "18:00"),
    );
  });
});

describe("crossesMidnight", () => {
  it("is true only when the end is earlier than the start", () => {
    expect(crossesMidnight("18:00", "06:00")).toBe(true);
    expect(crossesMidnight("22:00", "00:30")).toBe(true);
    expect(crossesMidnight("06:00", "18:00")).toBe(false);
    expect(crossesMidnight("00:00", "08:00")).toBe(false);
  });
});

describe("inclusiveDays", () => {
  it("counts both ends", () => {
    expect(inclusiveDays("2026-12-01", "2026-12-01")).toBe(1);
    expect(inclusiveDays("2026-12-01", "2026-12-07")).toBe(7);
    expect(inclusiveDays("2027-03-01", "2027-03-31")).toBe(31);
    expect(inclusiveDays("2026-12-01", "2027-01-01")).toBe(32);
  });
});
