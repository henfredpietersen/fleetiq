// Licence expiry warning for the driver list and detail screens (PRD §5.4; DEC-22 later uses the same facts for
// allocation eligibility). Dates are plain calendar dates (YYYY-MM-DD) in Africa/Johannesburg, never instants.
// The warning window is a PROPOSED default (30 days), configurable via LICENCE_EXPIRY_WARNING_DAYS.

export const DEFAULT_LICENCE_WARNING_DAYS = 30;

export type BadgeState =
  "none" | "valid" | "expiring" | "expired" | "unverified";
export type LicenceBadge = { state: BadgeState; label: string };

/** Today's calendar date in South Africa. */
export function sastToday(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Johannesburg",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

const DAY_MS = 86_400_000;
const utc = (d: string) => Date.parse(`${d}T00:00:00Z`);

/** Whole days from `today` to `date` (negative = already past). */
export function daysUntil(date: string, today: string): number {
  return Math.round((utc(date) - utc(today)) / DAY_MS);
}

export function readWarningDays(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.LICENCE_EXPIRY_WARNING_DAYS?.trim();
  if (!raw) return DEFAULT_LICENCE_WARNING_DAYS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 365)
    throw new Error(
      "LICENCE_EXPIRY_WARNING_DAYS must be an integer between 1 and 365",
    );
  return n;
}

export type LicenceSummary = {
  licenceExpiry: string | null;
  prdpExpiry: string | null;
  verification: string | null;
};

const plural = (n: number) => `${n} day${n === 1 ? "" : "s"}`;

/**
 * One badge for the register: expired beats expiring beats unverified beats valid. The licence and the PrDP are
 * both checked; "expired" on either is what a supervisor needs to see first.
 */
export function licenceBadge(
  s: LicenceSummary,
  today: string,
  warningDays: number = DEFAULT_LICENCE_WARNING_DAYS,
): LicenceBadge {
  if (!s.licenceExpiry) return { state: "none", label: "No licence recorded" };
  const parts = [
    { name: "Licence", date: s.licenceExpiry },
    ...(s.prdpExpiry ? [{ name: "PrDP", date: s.prdpExpiry }] : []),
  ].map((p) => ({ ...p, days: daysUntil(p.date, today) }));

  const expired = parts.find((p) => p.days < 0);
  if (expired)
    return {
      state: "expired",
      label: `${expired.name} expired ${expired.date}`,
    };
  const soonest = [...parts].sort((a, b) => a.days - b.days)[0];
  if (soonest.days <= warningDays)
    return {
      state: "expiring",
      label:
        soonest.days === 0
          ? `${soonest.name} expires today`
          : `${soonest.name} expires in ${plural(soonest.days)}`,
    };
  if (s.verification !== "verified")
    return { state: "unverified", label: "Licence not yet verified" };
  return { state: "valid", label: "Licence valid" };
}
