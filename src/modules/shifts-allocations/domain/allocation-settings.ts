// Allocation lifecycle settings (DEC-40: configurable defaults). ONE place in TypeScript, mirroring the SQL function
// public.allocation_settings(company_id) (migration 032). Both move to the company settings table when Phase 4/5 adds one.
// Every rule reads these; nothing hard-codes 60 or 30.
export type AllocationSettings = {
  openBeforeStartMinutes: number;
  noShowGraceMinutes: number;
};

export const DEFAULT_ALLOCATION_SETTINGS: AllocationSettings = {
  openBeforeStartMinutes: 60,
  noShowGraceMinutes: 30,
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
