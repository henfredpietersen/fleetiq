import { describe, expect, it } from "vitest";
import {
  addDays,
  computeServiceStatus,
  isAwaitingVerification,
  selectBaseline,
  type ConfigValues,
  type ServiceRecordLite,
} from "./service-status";

const def: ConfigValues = {
  serviceIntervalKm: 15000,
  earlyToleranceKm: 1500,
  lateToleranceKm: 1500,
  serviceIntervalDays: null,
  earlyToleranceDays: null,
  lateToleranceDays: null,
};
let n = 0;
const rec = (
  status: ServiceRecordLite["status"],
  serviceDate: string,
  odometerKm: number,
): ServiceRecordLite => ({
  id: `r${++n}`,
  status,
  serviceDate,
  odometerKm,
  createdAt: `2026-01-01T00:00:${String(n).padStart(2, "0")}Z`,
});

describe("the PRD §5.10.2 examples (same numbers as the pgTAP suite)", () => {
  it("verified at 82,400 km -> 95,900 / 97,400 / 98,900", () => {
    const s = computeServiceStatus([rec("verified", "2026-10-01", 82400)], def);
    expect(s.earlyWarningOdometerKm).toBe(95900);
    expect(s.nextServiceOdometerKm).toBe(97400);
    expect(s.lateToleranceOdometerKm).toBe(98900);
    expect(s.baselineRequired).toBe(false);
  });
  it("a late service at 99,500 km sets the next target at 114,500 (never rounded)", () => {
    const s = computeServiceStatus(
      [
        rec("verified", "2026-10-01", 82400),
        rec("verified", "2026-11-10", 99500),
      ],
      def,
    );
    expect(s.lastVerifiedServiceOdometerKm).toBe(99500);
    expect(s.nextServiceOdometerKm).toBe(114500);
    expect(s.earlyWarningOdometerKm).toBe(113000);
    expect(s.lateToleranceOdometerKm).toBe(116000);
  });
  it("a config change mid-cycle keeps the baseline and uses the interval in effect today", () => {
    const s = computeServiceStatus([rec("verified", "2026-10-01", 82400)], {
      ...def,
      serviceIntervalKm: 10000,
      earlyToleranceKm: 1000,
      lateToleranceKm: 1000,
    });
    expect([
      s.earlyWarningOdometerKm,
      s.nextServiceOdometerKm,
      s.lateToleranceOdometerKm,
    ]).toEqual([91400, 92400, 93400]);
  });
});

describe("only a verified record sets the baseline (DEC-20, DEC-24)", () => {
  it("no records: Baseline required, nothing invented", () => {
    const s = computeServiceStatus([], def);
    expect(s.baselineRequired).toBe(true);
    expect(s.nextServiceOdometerKm).toBeNull();
    expect(s.awaitingVerification).toBe(false);
  });
  it("recorded only: still Baseline required, flagged awaiting verification", () => {
    const s = computeServiceStatus([rec("recorded", "2026-10-01", 60000)], def);
    expect(s.baselineRequired).toBe(true);
    expect(s.awaitingVerification).toBe(true);
    expect(s.lastVerifiedServiceOdometerKm).toBeNull();
  });
  it("rejected only: Baseline required, not awaiting", () => {
    const s = computeServiceStatus([rec("rejected", "2026-10-01", 60000)], def);
    expect(s.baselineRequired).toBe(true);
    expect(s.awaitingVerification).toBe(false);
  });
  it("a newer recorded or rejected row never moves the baseline", () => {
    const records = [
      rec("verified", "2026-09-01", 50000),
      rec("recorded", "2026-10-01", 65000),
      rec("rejected", "2026-11-01", 80000),
    ];
    expect(selectBaseline(records)?.odometerKm).toBe(50000);
    expect(isAwaitingVerification(records, selectBaseline(records))).toBe(true);
  });
  it("a recorded row older than the baseline is not awaiting", () => {
    const records = [
      rec("verified", "2026-09-01", 50000),
      rec("recorded", "2026-01-01", 20000),
    ];
    expect(isAwaitingVerification(records, selectBaseline(records))).toBe(
      false,
    );
  });
  it("ties on the service date break on the higher odometer", () => {
    expect(
      selectBaseline([
        rec("verified", "2026-09-01", 50000),
        rec("verified", "2026-09-01", 50100),
      ])?.odometerKm,
    ).toBe(50100);
  });
});

describe("time basis (DEC-11: values come from the configuration)", () => {
  const timed: ConfigValues = {
    ...def,
    serviceIntervalDays: 180,
    earlyToleranceDays: 20,
    lateToleranceDays: 25,
  };
  it("no interval days: no due dates", () => {
    expect(
      computeServiceStatus([rec("verified", "2026-10-01", 1000)], def)
        .serviceDueDate,
    ).toBeNull();
  });
  it("due = service date + interval; early / late from the configured tolerance days", () => {
    const s = computeServiceStatus(
      [rec("verified", "2026-01-01", 1000)],
      timed,
    );
    expect(s.serviceDueDate).toBe("2026-06-30");
    expect(s.earlyWarningDate).toBe("2026-06-10");
    expect(s.lateToleranceDate).toBe("2026-07-25");
  });
  it("no baseline: no dates even when configured", () => {
    expect(computeServiceStatus([], timed).serviceDueDate).toBeNull();
  });
  it("addDays crosses month and year ends", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
});

describe("no configuration", () => {
  it("shows the baseline but no targets", () => {
    const s = computeServiceStatus(
      [rec("verified", "2026-10-01", 82400)],
      null,
    );
    expect(s.lastVerifiedServiceOdometerKm).toBe(82400);
    expect(s.nextServiceOdometerKm).toBeNull();
  });
});
