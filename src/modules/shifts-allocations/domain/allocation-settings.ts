// Allocation and inspection settings (DEC-40 start window / no-show grace, DEC-17 late windows: configurable defaults).
// ONE place in TypeScript, mirroring the SQL function public.allocation_settings(company_id) (migrations 032, 037, 051). Since 5A the
// SQL function takes the two LATE minutes from the company-default row of odometer_validation_settings in effect now (these are its
// seeded defaults); the start window (60) and no-show grace (30) stay constants. Every rule reads these; nothing hard-codes 60, 30 or 60.
export type AllocationSettings = {
  openBeforeStartMinutes: number;
  noShowGraceMinutes: number;
  /** DEC-17 (amended 2026-11-24): a pre-shift inspection is late when submitted more than this many minutes after the ALLOCATION's planned start. */
  preShiftLateMinutes: number;
  /** DEC-17: a post-shift inspection is late when submitted more than this many minutes after the allocation's planned end. */
  postShiftLateMinutes: number;
};

export const DEFAULT_ALLOCATION_SETTINGS: AllocationSettings = {
  openBeforeStartMinutes: 60,
  noShowGraceMinutes: 30,
  preShiftLateMinutes: 30,
  postShiftLateMinutes: 60,
};

export const allocationSettings = (): AllocationSettings =>
  DEFAULT_ALLOCATION_SETTINGS;

const MIN = 60_000;

/** Start window: [planned start - openBefore, planned end). Mirror of allocation_start_window_open(). */
export function startWindowOpen(
  plannedStart: Date,
  plannedEnd: Date,
  now: Date,
  s: AllocationSettings = allocationSettings(),
): boolean {
  return (
    now.getTime() >= plannedStart.getTime() - s.openBeforeStartMinutes * MIN &&
    now.getTime() < plannedEnd.getTime()
  );
}

/** First moment a no-show may be recorded: planned start + grace (inclusive). Mirror of allocation_no_show_allowed(). */
export function noShowAllowed(
  plannedStart: Date,
  now: Date,
  s: AllocationSettings = allocationSettings(),
): boolean {
  return now.getTime() >= plannedStart.getTime() + s.noShowGraceMinutes * MIN;
}

export const noShowFrom = (
  plannedStart: Date,
  s: AllocationSettings = allocationSettings(),
) => new Date(plannedStart.getTime() + s.noShowGraceMinutes * MIN);
export const startOpensAt = (
  plannedStart: Date,
  s: AllocationSettings = allocationSettings(),
) => new Date(plannedStart.getTime() - s.openBeforeStartMinutes * MIN);

/**
 * DEC-17 late rule (amended 2026-11-24), strictly "more than", both measured from the ALLOCATION: pre-shift = submitted after
 * the allocation's planned start + preShiftLateMinutes; post-shift = submitted after its planned end + postShiftLateMinutes.
 * Mirror of inspection_is_late() (migration 039) as called by submit_inspection() since migration 040.
 * Judged on the SERVER submit time, never the device clock, and it never blocks a submission.
 */
export function inspectionIsLate(
  stage: "pre_shift" | "post_shift",
  submittedAt: Date,
  plannedStart: Date,
  plannedEnd: Date,
  s: AllocationSettings = allocationSettings(),
): boolean {
  return stage === "pre_shift"
    ? submittedAt.getTime() >
        plannedStart.getTime() + s.preShiftLateMinutes * MIN
    : submittedAt.getTime() >
        plannedEnd.getTime() + s.postShiftLateMinutes * MIN;
}
