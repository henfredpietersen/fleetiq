import { SHIFT_TIME_ZONE } from "./shift-times";

/** "06:00:00" -> "06:00" (Postgres time values arrive with seconds). */
export const formatClock = (t: string) => t.slice(0, 5);

export const formatShiftDate = (iso: string) =>
  new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-ZA", {
    timeZone: "UTC",
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
  });

/** The scheduled instant as local Africa/Johannesburg HH:MM. */
export const formatLocalClock = (instant: string) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: SHIFT_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(instant));

/** "06:00–18:00" or "18:00–06:00 (+1 day)" for a scheduled start/end pair. */
export function formatShiftWindow(startAt: string, endAt: string): string {
  const dayOf = (i: string) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: SHIFT_TIME_ZONE }).format(
      new Date(i),
    );
  const next = dayOf(endAt) !== dayOf(startAt);
  return `${formatLocalClock(startAt)}–${formatLocalClock(endAt)}${next ? " (+1 day)" : ""}`;
}
