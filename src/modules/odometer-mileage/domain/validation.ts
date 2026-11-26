// The reading validation rules (PRD v1.20 §5.8.8, DEC-12..DEC-17, DEC-44). A PURE mirror of the SQL function odometer_evaluate_checks()
// (migration 053): the SAME test vectors (validation.fixture.json) run against both. The database is authoritative; this exists so the
// phone, the reviewer screens and the tests can reason about a result without a round trip. Values are LIFETIME km (displayed + offset).
// Nothing here ever attributes a distance to a driver.
export type CheckKey =
  | "decreasing_reading"
  | "implausible_distance"
  | "unaccounted_distance"
  | "duplicate_image"
  | "gallery_upload"
  | "late_inspection";
/** pass | fail | not_configured | waiting. not_configured and waiting are NOT failures (DEC-44). */
export type CheckResult = "pass" | "fail" | "not_configured" | "waiting";
export type Route = "quick_check" | "full";

export type ChecksInput = {
  stage: "pre_shift" | "post_shift";
  driver_lifetime_km: number;
  /** The vehicle's latest ACCEPTED reading strictly before this one by allocation chronology (null = none). */
  latest_accepted_lifetime_km: number | null;
  /** An earlier reading of the vehicle still awaits review. */
  earlier_unaccepted_exists: boolean;
  /** Post-shift only: the same allocation's pre-shift reading. */
  pre_reading: { lifetime_km: number; accepted: boolean } | null;
  /** Pre-shift only: the previous allocation's post-shift reading (null = there is none). */
  previous_post: { lifetime_km: number | null; accepted: boolean } | null;
  /** null = not configured (DEC-15). */
  max_km_per_allocation: number | null;
  unaccounted_tolerance_km: number;
  duplicate_image: boolean;
  capture_source: string | null;
  late_flag: boolean;
};

export type Check = {
  key: CheckKey;
  result: CheckResult;
  values: Record<string, unknown>;
};
export type ChecksOutput = {
  checks: Check[];
  failed: CheckKey[];
  route: Route;
};

export function evaluateChecks(p: ChecksInput): ChecksOutput {
  const km = p.driver_lifetime_km;
  const checks: Check[] = [];

  // decreasing_reading: lower than the latest accepted reading before it (equal passes); waiting only when NO accepted reading exists
  // and an earlier one is still unaccepted.
  if (p.latest_accepted_lifetime_km !== null) {
    checks.push({
      key: "decreasing_reading",
      result: km < p.latest_accepted_lifetime_km ? "fail" : "pass",
      values: {
        driver_lifetime_km: km,
        previous_accepted_lifetime_km: p.latest_accepted_lifetime_km,
      },
    });
  } else {
    checks.push({
      key: "decreasing_reading",
      result: p.earlier_unaccepted_exists ? "waiting" : "pass",
      values: { driver_lifetime_km: km },
    });
  }

  if (p.stage === "post_shift") {
    if (p.max_km_per_allocation === null) {
      checks.push({
        key: "implausible_distance",
        result: "not_configured",
        values: { max_km_per_allocation: null },
      });
    } else if (p.pre_reading === null) {
      checks.push({
        key: "implausible_distance",
        result: "waiting",
        values: { max_km_per_allocation: p.max_km_per_allocation },
      });
    } else {
      const distance = km - p.pre_reading.lifetime_km;
      checks.push({
        key: "implausible_distance",
        result: distance > p.max_km_per_allocation ? "fail" : "pass",
        values: {
          distance_km: distance,
          pre_lifetime_km: p.pre_reading.lifetime_km,
          pre_basis: p.pre_reading.accepted ? "accepted" : "driver",
          max_km_per_allocation: p.max_km_per_allocation,
        },
      });
    }
  }

  if (p.stage === "pre_shift") {
    if (p.previous_post === null) {
      checks.push({
        key: "unaccounted_distance",
        result: "pass",
        values: {},
      });
    } else if (!p.previous_post.accepted) {
      checks.push({
        key: "unaccounted_distance",
        result: "waiting",
        values: { tolerance_km: p.unaccounted_tolerance_km },
      });
    } else {
      const gap = km - (p.previous_post.lifetime_km ?? 0);
      checks.push({
        key: "unaccounted_distance",
        result: gap > p.unaccounted_tolerance_km ? "fail" : "pass",
        values: {
          gap_km: gap,
          previous_post_lifetime_km: p.previous_post.lifetime_km,
          tolerance_km: p.unaccounted_tolerance_km,
        },
      });
    }
  }

  checks.push(
    {
      key: "duplicate_image",
      result: p.duplicate_image ? "fail" : "pass",
      values: {},
    },
    // DEC-04: the in-app camera is the only way in, so this cannot fail today; it records the capture source.
    {
      key: "gallery_upload",
      result: (p.capture_source ?? "") !== "in_app_camera" ? "fail" : "pass",
      values: { capture_source: p.capture_source },
    },
    {
      key: "late_inspection",
      result: p.late_flag ? "fail" : "pass",
      values: {},
    },
  );

  const failed = checks.filter((c) => c.result === "fail").map((c) => c.key);
  return { checks, failed, route: failed.length > 0 ? "full" : "quick_check" };
}

/** DEC-44: where a reading goes. A check that is not_configured or waiting does not count as failed. */
export const routeOf = (results: CheckResult[]): Route =>
  results.includes("fail") ? "full" : "quick_check";
