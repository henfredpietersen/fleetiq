import { describe, expect, it } from "vitest";
import fixture from "./inspection-due-status.fixture.json";
import { inspectionDueStatus } from "./inspection-due-status";

describe("inspectionDueStatus matches the SQL function (migration 049) through the shared fixture", () => {
  for (const c of fixture.cases) {
    it(c.name, () => {
      expect(
        inspectionDueStatus({
          stage: c.stage,
          allocationStatus: c.allocationStatus,
          plannedStartAt: c.plannedStartAt,
          plannedEndAt: c.plannedEndAt,
          submittedAt: c.submittedAt,
          now: c.now,
          preMinutes: c.preMinutes,
          postMinutes: c.postMinutes,
        }),
      ).toBe(c.expect);
    });
  }
  it("covers every status the function can return", () => {
    expect(new Set(fixture.cases.map((c) => c.expect))).toEqual(
      new Set([
        "not_due",
        "due_now",
        "overdue",
        "submitted",
        "submitted_late",
        "not_applicable",
        null,
      ]),
    );
  });
});
