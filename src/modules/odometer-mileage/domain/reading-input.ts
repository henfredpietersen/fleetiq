// The driver's reading, typed blind (DEC-05): whole kilometres (DEC-12), digits only, 0 to 9,999,999. The database re-checks it.
export const READING_MAX_KM = 9_999_999;
export const READING_MAX_DIGITS = 7;

export type ParsedReading =
  { ok: true; km: number } | { ok: false; message: string };

export const READING_ERROR =
  "Enter the reading as whole kilometres, using digits only (no spaces, commas or decimals).";

/** Strips what a phone keypad leaves behind that is harmless (surrounding spaces); anything else is an error, never silently changed. */
export function parseReading(raw: string): ParsedReading {
  const s = raw.trim();
  if (s === "")
    return {
      ok: false,
      message: "Enter the odometer reading shown in your photo.",
    };
  if (!/^[0-9]+$/.test(s)) return { ok: false, message: READING_ERROR };
  if (s.length > READING_MAX_DIGITS)
    return {
      ok: false,
      message: `A reading has at most ${READING_MAX_DIGITS} digits.`,
    };
  return { ok: true, km: Number(s) };
}

/** Live filter for the input: digits only, at most 7. */
export const digitsOnly = (raw: string): string =>
  raw.replace(/[^0-9]/g, "").slice(0, READING_MAX_DIGITS);
