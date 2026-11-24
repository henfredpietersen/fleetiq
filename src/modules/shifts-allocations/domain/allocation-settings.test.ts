import { describe, expect, it } from "vitest";
import {
  allocationSettings,
  DEFAULT_ALLOCATION_SETTINGS,
  inspectionIsLate,
  noShowAllowed,
  noShowFrom,
  startOpensAt,
  startWindowOpen,
} from "./allocation-settings";

const t0 = new Date("2026-11-18T08:00:00Z");
const at = (min: number, sec = 0) =>
  new Date(t0.getTime() + (min * 60 + sec) * 1000);

describe("allocation settings (DEC-40 defaults)", () => {
  it("defaults to 60 and 30 (DEC-40) and the DEC-17 late windows 30 and 60", () => {
    expect(allocationSettings()).toEqual({
      openBeforeStartMinutes: 60,
      noShowGraceMinutes: 30,
      preShiftLateMinutes: 30,
      postShiftLateMinutes: 60,
    });
  });
  it("start window: inclusive at start - 60 min, exclusive at the planned end", () => {
    const end = at(480);
    expect(startWindowOpen(t0, end, at(-61))).toBe(false);
    expect(startWindowOpen(t0, end, at(-60))).toBe(true);
    expect(startWindowOpen(t0, end, at(480, -1))).toBe(true);
    expect(startWindowOpen(t0, end, end)).toBe(false);
  });
  it("the settings move the window and the grace (nothing is hard-coded)", () => {
    expect(startWindowOpen(t0, at(480), at(-90))).toBe(false);
    expect(
      startWindowOpen(t0, at(480), at(-90), {
        ...DEFAULT_ALLOCATION_SETTINGS,
        openBeforeStartMinutes: 120,
      }),
    ).toBe(true);
    expect(noShowAllowed(t0, at(20))).toBe(false);
    expect(
      noShowAllowed(t0, at(20), {
        ...DEFAULT_ALLOCATION_SETTINGS,
        noShowGraceMinutes: 15,
      }),
    ).toBe(true);
  });
  it("no-show: from start + 30 min inclusive", () => {
    expect(noShowAllowed(t0, at(29, 59))).toBe(false);
    expect(noShowAllowed(t0, at(30))).toBe(true);
    expect(noShowFrom(t0)).toEqual(at(30));
    expect(startOpensAt(t0)).toEqual(at(-60));
  });
});

describe("inspection late rule (DEC-17)", () => {
  const shiftStart = t0;
  const plannedEnd = at(480);
  it("pre-shift: not late at 29 and 30 minutes, late at 31 (strictly more than 30)", () => {
    expect(inspectionIsLate("pre_shift", at(29), shiftStart, plannedEnd)).toBe(
      false,
    );
    expect(inspectionIsLate("pre_shift", at(30), shiftStart, plannedEnd)).toBe(
      false,
    );
    expect(
      inspectionIsLate("pre_shift", at(30, 1), shiftStart, plannedEnd),
    ).toBe(true);
    expect(inspectionIsLate("pre_shift", at(31), shiftStart, plannedEnd)).toBe(
      true,
    );
  });
  it("post-shift: judged from the planned end, not late at 59 and 60 minutes, late at 61", () => {
    expect(
      inspectionIsLate("post_shift", at(480 + 59), shiftStart, plannedEnd),
    ).toBe(false);
    expect(
      inspectionIsLate("post_shift", at(480 + 60), shiftStart, plannedEnd),
    ).toBe(false);
    expect(
      inspectionIsLate("post_shift", at(480 + 61), shiftStart, plannedEnd),
    ).toBe(true);
  });
  it("the windows are settings, not constants", () => {
    const s = {
      ...DEFAULT_ALLOCATION_SETTINGS,
      preShiftLateMinutes: 10,
      postShiftLateMinutes: 5,
    };
    expect(
      inspectionIsLate("pre_shift", at(11), shiftStart, plannedEnd, s),
    ).toBe(true);
    expect(
      inspectionIsLate("pre_shift", at(10), shiftStart, plannedEnd, s),
    ).toBe(false);
    expect(
      inspectionIsLate("post_shift", at(480 + 6), shiftStart, plannedEnd, s),
    ).toBe(true);
  });
});
