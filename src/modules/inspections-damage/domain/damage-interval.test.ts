import { describe, expect, it } from "vitest";
import { intervalText, NO_FAULT_NOTE } from "./damage-interval";

describe("intervalText", () => {
  it("says nothing for a post-shift report", () => {
    expect(intervalText(null)).toBeNull();
  });
  it("names the previous post-shift inspection and allocation", () => {
    const t = intervalText({
      previous_allocation_id: "abcdef12-0000-4000-8000-000000000000",
      previous_allocation_planned_start_at: "2026-11-23T04:00:00Z",
      previous_allocation_planned_end_at: "2026-11-23T14:00:00Z",
      previous_post_shift_submitted_at: "2026-11-23T14:20:00Z",
    });
    expect(t).toMatch(
      /^Appeared after the post-shift inspection of .*2026.* on allocation ABCDEF12\.$/,
    );
  });
  it("handles a previous allocation with no post-shift inspection, and no previous allocation", () => {
    expect(
      intervalText({
        previous_allocation_id: "abcdef12-0000-4000-8000-000000000000",
        previous_allocation_planned_start_at: null,
        previous_allocation_planned_end_at: null,
        previous_post_shift_submitted_at: null,
      }),
    ).toMatch(/no submitted post-shift inspection/);
    expect(
      intervalText({
        previous_allocation_id: null,
        previous_allocation_planned_start_at: null,
        previous_allocation_planned_end_at: null,
        previous_post_shift_submitted_at: null,
      }),
    ).toBe("No previous post-shift inspection.");
  });
  it("never uses blame wording", () => {
    const all = [
      NO_FAULT_NOTE,
      intervalText({
        previous_allocation_id: "abcdef12-0000-4000-8000-000000000000",
        previous_allocation_planned_start_at: null,
        previous_allocation_planned_end_at: null,
        previous_post_shift_submitted_at: "2026-11-23T14:20:00Z",
      }),
      intervalText({
        previous_allocation_id: null,
        previous_allocation_planned_start_at: null,
        previous_allocation_planned_end_at: null,
        previous_post_shift_submitted_at: null,
      }),
    ].join(" ");
    expect(all).not.toMatch(
      /blame|liable|responsible for|caused by the driver|your fault/i,
    );
  });
});
