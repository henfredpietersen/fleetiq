import { describe, expect, it } from "vitest";
import {
  isValidResponse,
  needsComment,
  responseOptions,
  stageFromSlug,
  stageSlug,
} from "./inspection-rules";

describe("answer values per response type (mirror of inspection_response_valid)", () => {
  it("ok_defect accepts ok and defect; na only where allowed", () => {
    expect(isValidResponse("ok_defect", "ok", false)).toBe(true);
    expect(isValidResponse("ok_defect", "defect", false)).toBe(true);
    expect(isValidResponse("ok_defect", "na", false)).toBe(false);
    expect(isValidResponse("ok_defect", "na", true)).toBe(true);
    expect(isValidResponse("ok_defect", "maybe", true)).toBe(false);
  });
  it("fuel_quarter accepts E, 1/4, 1/2, 3/4, F only (never N/A)", () => {
    for (const v of ["E", "1/4", "1/2", "3/4", "F"])
      expect(isValidResponse("fuel_quarter", v, false)).toBe(true);
    for (const v of ["1/3", "e", "full", "na", "ok"])
      expect(isValidResponse("fuel_quarter", v, true)).toBe(false);
  });
  it("yes_no_detail accepts yes and no only", () => {
    expect(isValidResponse("yes_no_detail", "yes", false)).toBe(true);
    expect(isValidResponse("yes_no_detail", "no", false)).toBe(true);
    expect(isValidResponse("yes_no_detail", "na", true)).toBe(false);
    expect(isValidResponse("yes_no_detail", "ok", false)).toBe(false);
  });
  it("an unknown response type accepts nothing", () => {
    expect(isValidResponse("rating", "ok", true)).toBe(false);
  });
  it("the options offered hide N/A unless the item allows it", () => {
    expect(responseOptions("ok_defect", false).map((o) => o.value)).toEqual([
      "ok",
      "defect",
    ]);
    expect(responseOptions("ok_defect", true).map((o) => o.value)).toEqual([
      "ok",
      "defect",
      "na",
    ]);
    expect(responseOptions("fuel_quarter", false)).toHaveLength(5);
  });
  it("a Defect and a Yes need a comment; nothing else does", () => {
    expect(needsComment("ok_defect", "defect")).toBe(true);
    expect(needsComment("yes_no_detail", "yes")).toBe(true);
    expect(needsComment("ok_defect", "ok")).toBe(false);
    expect(needsComment("yes_no_detail", "no")).toBe(false);
    expect(needsComment("fuel_quarter", "E")).toBe(false);
    expect(needsComment("ok_defect", undefined)).toBe(false);
  });
  it("stage slugs round-trip and reject anything else", () => {
    expect(stageFromSlug("pre-shift")).toBe("pre_shift");
    expect(stageFromSlug("post-shift")).toBe("post_shift");
    expect(stageFromSlug("pre_shift")).toBeNull();
    expect(stageSlug("post_shift")).toBe("post-shift");
  });
});
