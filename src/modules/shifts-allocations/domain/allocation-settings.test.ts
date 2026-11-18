import { describe, expect, it } from "vitest";
import {
  allocationSettings,
  noShowAllowed,
  noShowFrom,
  startOpensAt,
  startWindowOpen,
} from "./allocation-settings";

const t0 = new Date("2026-11-18T08:00:00Z");
const at = (min: number, sec = 0) =>
  new Date(t0.getTime() + (min * 60 + sec) * 1000);

describe("allocation settings (DEC-40 defaults)", () => {
  it("defaults to 60 and 30", () => {
    expect(allocationSettings()).toEqual({
      openBeforeStartMinutes: 60,
      noShowGraceMinutes: 30,
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
        openBeforeStartMinutes: 120,
        noShowGraceMinutes: 30,
      }),
    ).toBe(true);
    expect(noShowAllowed(t0, at(20))).toBe(false);
    expect(
      noShowAllowed(t0, at(20), {
        openBeforeStartMinutes: 60,
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
