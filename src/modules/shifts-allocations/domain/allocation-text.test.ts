import { describe, expect, it } from "vitest";
import {
  allocationStatusLabel,
  blockReasonText,
  explainEligibility,
  licenceCheckLabel,
} from "./allocation-text";

const base = {
  ok: true,
  blockReasons: [],
  licenceClassCheck: "matched",
  needsOverride: false,
};

describe("explainEligibility", () => {
  it("allowed: matched", () => {
    const e = explainEligibility(base);
    expect(e.tone).toBe("ok");
    expect(e.lines[0]).toMatch(/covers this vehicle/);
  });
  it("allowed: licence class not checked when the vehicle has no required code", () => {
    const e = explainEligibility({
      ...base,
      licenceClassCheck: "not_configured",
    });
    expect(e.tone).toBe("ok");
    expect(e.lines[0]).toMatch(/not checked/);
  });
  it("a class mismatch says it goes for approval and needs a reason", () => {
    const e = explainEligibility({
      ...base,
      licenceClassCheck: null,
      needsOverride: true,
    });
    expect(e.tone).toBe("warning");
    expect(e.lines[0]).toMatch(/approval/);
    expect(e.lines[0]).toMatch(/reason/);
  });
  it("blocked: one plain sentence per reason, never a code", () => {
    const e = explainEligibility({
      ok: false,
      blockReasons: [
        "no_eligible_licence",
        "vehicle_conflict",
        "driver_conflict",
      ],
      licenceClassCheck: null,
      needsOverride: false,
    });
    expect(e.tone).toBe("blocked");
    expect(e.lines).toHaveLength(3);
    expect(e.lines[0]).toMatch(/cannot be overridden/);
    expect(e.lines.join(" ")).not.toMatch(
      /no_eligible_licence|vehicle_conflict/,
    );
  });
  it("every block reason from the database has its own sentence", () => {
    for (const r of [
      "vehicle_not_available",
      "vehicle_wrong_branch",
      "driver_inactive",
      "driver_wrong_branch",
      "shift_not_scheduled",
      "no_eligible_licence",
      "vehicle_conflict",
      "driver_conflict",
    ])
      expect(blockReasonText(r)).not.toBe("This combination is not allowed.");
  });
});

describe("labels", () => {
  it("licence badges", () => {
    expect(licenceCheckLabel("matched").label).toBe("Licence matched");
    expect(licenceCheckLabel("override_approved").label).toBe(
      "Licence override approved",
    );
    expect(licenceCheckLabel("not_configured").label).toBe(
      "Licence class not checked",
    );
  });
  it("status labels cover the eight statuses", () => {
    for (const s of [
      "planned",
      "pre_inspection_pending",
      "in_use",
      "post_inspection_pending",
      "closed",
      "closed_with_exceptions",
      "cancelled",
      "no_show",
    ])
      expect(allocationStatusLabel(s)).not.toBe(s);
  });
});
