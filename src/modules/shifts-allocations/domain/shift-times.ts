// The TypeScript mirror of the SQL function public.shift_times(p_date, p_start, p_end) (migration 027). The database is
// the authority; this exists for previews and tests, and both sides share the same cases (shift-times.test.ts and
// supabase/tests/database/phase3a_shifts.test.sql).
// Rule: times are Africa/Johannesburg wall-clock; the shift's date is its local start date; when the end time is
// earlier than the start time the shift ends on the next day. South Africa has had no daylight saving since 1944, so
// the zone is a constant UTC+2 and local -> UTC is a fixed two-hour shift (no gaps or overlaps to resolve).
export const SHIFT_TIME_ZONE = "Africa/Johannesburg";
const SAST_OFFSET_MINUTES = 120;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

export const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;

export type ShiftTimes = {
  /** ISO-8601 UTC instants, like Postgres timestamptz rendered in UTC. */
  scheduledStartAt: string;
  scheduledEndAt: string;
};

function parseDate(date: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new RangeError(`Invalid date: ${date}`);
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (new Date(ms).toISOString().slice(0, 10) !== date)
    throw new RangeError(`Invalid date: ${date}`);
  return ms;
}

/** Minutes since local midnight. */
function parseTime(time: string): number {
  const m = TIME_PATTERN.exec(time);
  if (!m) throw new RangeError(`Invalid time: ${time}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** True when a shift from `start` to `end` runs past local midnight (end earlier than start). */
export function crossesMidnight(start: string, end: string): boolean {
  return parseTime(end) < parseTime(start);
}

export function shiftTimes(
  date: string,
  start: string,
  end: string,
): ShiftTimes {
  const day = parseDate(date);
  const s = parseTime(start);
  const e = parseTime(end);
  if (s === e)
    throw new RangeError("The start and end time cannot be the same");
  const toUtc = (dayMs: number, minutes: number) =>
    new Date(dayMs + (minutes - SAST_OFFSET_MINUTES) * MINUTE).toISOString();
  return {
    scheduledStartAt: toUtc(day, s),
    scheduledEndAt: toUtc(e < s ? day + DAY : day, e),
  };
}

/** The Africa/Johannesburg calendar date (YYYY-MM-DD) of an instant, e.g. for "today" defaults. */
export function localDate(instant: Date | string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: SHIFT_TIME_ZONE }).format(
    new Date(instant),
  );
}

/** Whole days from `from` to `to` inclusive (both YYYY-MM-DD). */
export function inclusiveDays(from: string, to: string): number {
  return Math.round((parseDate(to) - parseDate(from)) / DAY) + 1;
}
