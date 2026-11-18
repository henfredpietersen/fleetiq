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

/** ISO instant -> "YYYY-MM-DDTHH:mm" in Africa/Johannesburg, for <input type="datetime-local">. */
export function toLocalInput(instant: string): string {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: SHIFT_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(instant));
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? "00";
  return `${g("year")}-${g("month")}-${g("day")}T${g("hour")}:${g("minute")}`;
}

/** "YYYY-MM-DDTHH:mm" (Africa/Johannesburg, UTC+2, no DST) -> ISO with offset; null when malformed. */
export function fromLocalInput(v: string): string | null {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v) ? `${v}:00+02:00` : null;
}
