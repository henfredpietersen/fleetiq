// Pure mirror of public.vehicle_service_status (migration 025; PRD §5.10.2, §5.10.4, §5.10.7; DEC-20, DEC-24).
// Phase 2 scope ONLY: baseline, next / early-warning / late-tolerance odometers, due dates, the two flags.
// No km / time status bands (DEC-10, Phase 8) and no current mileage (accepted readings arrive in Phases 5-7).

export type RecordStatus = "recorded" | "verified" | "rejected";

export type ServiceRecordLite = {
  id: string;
  /** YYYY-MM-DD */
  serviceDate: string;
  odometerKm: number;
  status: RecordStatus;
  createdAt: string;
};

export type ConfigValues = {
  serviceIntervalKm: number;
  earlyToleranceKm: number;
  lateToleranceKm: number;
  serviceIntervalDays: number | null;
  earlyToleranceDays: number | null;
  lateToleranceDays: number | null;
};

export type ServiceStatus = {
  baselineRequired: boolean;
  awaitingVerification: boolean;
  lastVerifiedRecordId: string | null;
  lastVerifiedServiceDate: string | null;
  lastVerifiedServiceOdometerKm: number | null;
  nextServiceOdometerKm: number | null;
  earlyWarningOdometerKm: number | null;
  lateToleranceOdometerKm: number | null;
  serviceDueDate: string | null;
  earlyWarningDate: string | null;
  lateToleranceDate: string | null;
};

/** The baseline: the latest VERIFIED record. recorded and rejected records never are (DEC-20). */
export function selectBaseline(
  records: readonly ServiceRecordLite[],
): ServiceRecordLite | null {
  const verified = records.filter((r) => r.status === "verified");
  verified.sort(
    (a, b) =>
      b.serviceDate.localeCompare(a.serviceDate) ||
      b.odometerKm - a.odometerKm ||
      b.createdAt.localeCompare(a.createdAt),
  );
  return verified[0] ?? null;
}

/** A recorded record that is not older than the baseline is waiting for a verifier (PRD §5.10.3 flag). */
export function isAwaitingVerification(
  records: readonly ServiceRecordLite[],
  baseline: ServiceRecordLite | null,
): boolean {
  return records.some(
    (r) =>
      r.status === "recorded" &&
      (baseline === null || r.serviceDate >= baseline.serviceDate),
  );
}

export function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}

export function computeServiceStatus(
  records: readonly ServiceRecordLite[],
  config: ConfigValues | null,
): ServiceStatus {
  const baseline = selectBaseline(records);
  const hasTime = baseline !== null && config?.serviceIntervalDays != null;
  const next =
    baseline && config ? baseline.odometerKm + config.serviceIntervalKm : null;
  const due = hasTime
    ? addDays(baseline.serviceDate, config.serviceIntervalDays as number)
    : null;
  return {
    baselineRequired: baseline === null,
    awaitingVerification: isAwaitingVerification(records, baseline),
    lastVerifiedRecordId: baseline?.id ?? null,
    lastVerifiedServiceDate: baseline?.serviceDate ?? null,
    lastVerifiedServiceOdometerKm: baseline?.odometerKm ?? null,
    nextServiceOdometerKm: next,
    earlyWarningOdometerKm:
      next !== null && config ? next - config.earlyToleranceKm : null,
    lateToleranceOdometerKm:
      next !== null && config ? next + config.lateToleranceKm : null,
    serviceDueDate: due,
    earlyWarningDate:
      due && config ? addDays(due, -(config.earlyToleranceDays ?? 0)) : null,
    lateToleranceDate:
      due && config ? addDays(due, config.lateToleranceDays ?? 0) : null,
  };
}
