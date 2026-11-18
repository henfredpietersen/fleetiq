import { describe, expect, it } from "vitest";
import {
  adHocShiftSchema,
  archiveTemplateSchema,
  cancelShiftSchema,
  generateSchema,
  shiftFilterSchema,
  templateSchema,
  updateTemplateSchema,
} from "./shift-schema";

const B = "5eed0000-0000-4000-8000-0000000000b1";
const T = "5eed0000-0000-4000-8000-000000000801";
const C = "5eed0000-0000-4000-8000-000000000901";
const msgs = (r: {
  success: boolean;
  error?: { issues: { message: string }[] };
}) => r.error?.issues.map((i) => i.message) ?? [];

describe("templateSchema", () => {
  const ok = {
    branchId: B,
    name: " Day ",
    startTime: "06:00",
    endTime: "18:00",
  };
  it("trims the name and accepts a normal template", () => {
    const r = templateSchema.safeParse(ok);
    expect(r.success && r.data.name).toBe("Day");
  });
  it("accepts a template that crosses midnight", () => {
    expect(
      templateSchema.safeParse({ ...ok, startTime: "18:00", endTime: "06:00" })
        .success,
    ).toBe(true);
  });
  it.each([
    ["equal times", { endTime: "06:00" }],
    ["blank name", { name: "   " }],
    ["name over 100", { name: "x".repeat(101) }],
    ["bad time", { startTime: "6am" }],
    ["24:00", { endTime: "24:00" }],
    ["bad branch id", { branchId: "nope" }],
  ])("refuses %s", (_l, patch) => {
    expect(templateSchema.safeParse({ ...ok, ...patch }).success).toBe(false);
  });
  it("names the problem for equal times", () => {
    expect(
      msgs(templateSchema.safeParse({ ...ok, endTime: "06:00" })),
    ).toContain("The start and end time cannot be the same");
  });
});

describe("updateTemplateSchema / archiveTemplateSchema", () => {
  it("validates an edit", () => {
    expect(
      updateTemplateSchema.safeParse({
        templateId: T,
        name: "Day",
        startTime: "05:30",
        endTime: "17:30",
      }).success,
    ).toBe(true);
  });
  it("requires a reason (trimmed, at most 500) to archive", () => {
    expect(
      archiveTemplateSchema.safeParse({ templateId: T, reason: "  " }).success,
    ).toBe(false);
    expect(
      archiveTemplateSchema.safeParse({
        templateId: T,
        reason: "x".repeat(501),
      }).success,
    ).toBe(false);
    expect(
      archiveTemplateSchema.safeParse({ templateId: T, reason: "Discontinued" })
        .success,
    ).toBe(true);
  });
});

describe("generateSchema", () => {
  const base = {
    templateId: T,
    from: "2026-12-01",
    to: "2026-12-07",
    clientSubmissionId: C,
  };
  it("accepts a week, one day and exactly 31 days", () => {
    expect(generateSchema.safeParse(base).success).toBe(true);
    expect(
      generateSchema.safeParse({ ...base, to: "2026-12-01" }).success,
    ).toBe(true);
    expect(
      generateSchema.safeParse({ ...base, to: "2026-12-31" }).success,
    ).toBe(true);
  });
  it("refuses 32 days, a reversed range and bad dates", () => {
    expect(
      msgs(generateSchema.safeParse({ ...base, to: "2027-01-01" })),
    ).toContain("At most 31 days can be generated at once");
    expect(
      generateSchema.safeParse({ ...base, from: "2026-12-08" }).success,
    ).toBe(false);
    expect(
      generateSchema.safeParse({ ...base, from: "2026-02-30" }).success,
    ).toBe(false);
    expect(
      generateSchema.safeParse({ ...base, clientSubmissionId: "" }).success,
    ).toBe(false);
  });
});

describe("adHocShiftSchema", () => {
  const base = {
    branchId: B,
    departmentId: "",
    shiftDate: "2026-12-20",
    startTime: "22:00",
    endTime: "00:30",
    clientSubmissionId: C,
  };
  it("treats a blank department as none", () => {
    const r = adHocShiftSchema.safeParse(base);
    expect(r.success && r.data.departmentId).toBeUndefined();
  });
  it("accepts a department id", () => {
    expect(
      adHocShiftSchema.safeParse({ ...base, departmentId: T }).success,
    ).toBe(true);
  });
  it("refuses equal times, a bad department id and a missing date", () => {
    expect(
      adHocShiftSchema.safeParse({ ...base, endTime: "22:00" }).success,
    ).toBe(false);
    expect(
      adHocShiftSchema.safeParse({ ...base, departmentId: "x" }).success,
    ).toBe(false);
    expect(adHocShiftSchema.safeParse({ ...base, shiftDate: "" }).success).toBe(
      false,
    );
  });
});

describe("cancelShiftSchema / shiftFilterSchema", () => {
  it("needs a reason to cancel", () => {
    expect(
      cancelShiftSchema.safeParse({ shiftId: T, reason: "" }).success,
    ).toBe(false);
    expect(
      cancelShiftSchema.safeParse({ shiftId: T, reason: "Holiday" }).success,
    ).toBe(true);
  });
  it("filters accept blanks and refuse a reversed range", () => {
    expect(
      shiftFilterSchema.safeParse({ branchId: "", from: "", to: "" }).success,
    ).toBe(true);
    expect(
      shiftFilterSchema.safeParse({
        branchId: B,
        from: "2026-12-01",
        to: "2026-12-07",
      }).success,
    ).toBe(true);
    expect(
      shiftFilterSchema.safeParse({ from: "2026-12-08", to: "2026-12-01" })
        .success,
    ).toBe(false);
  });
});
