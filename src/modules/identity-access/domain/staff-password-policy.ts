import { randomInt } from "node:crypto";

// Staff (office/management) password policy. DEC-34: staff sign in with email + password.
// Supabase Auth's global minimum stays at 6 only because driver PINs share it (AD-08), so it is NEVER relied on
// for staff: every path that sets a staff password validates here first (see server/staff-accounts.ts).
// Length is the only rule (carry-over C3); the minimum is configurable via AUTH_STAFF_PASSWORD_MIN_LENGTH.

export type StaffPasswordRules = {
  /** Minimum length in characters (Unicode code points). Config cannot go below STAFF_PASSWORD_MIN_FLOOR. */
  minLength: number;
};

/** The configurable minimum can be raised, never lowered below this. */
export const STAFF_PASSWORD_MIN_FLOOR = 12;
/** Upper bound for the configured minimum, and for a submitted password (bounds hashing cost / abuse). */
export const STAFF_PASSWORD_MAX_LENGTH = 128;

export type StaffPasswordViolation = "too_short" | "too_long";

export type StaffPasswordCheck =
  { ok: true } | { ok: false; violations: StaffPasswordViolation[] };

export function validateStaffPassword(
  password: string,
  rules: StaffPasswordRules,
): StaffPasswordCheck {
  const length = [...password].length; // code points, so an emoji or accented letter counts once
  const violations: StaffPasswordViolation[] = [];
  if (length < rules.minLength) violations.push("too_short");
  if (length > STAFF_PASSWORD_MAX_LENGTH) violations.push("too_long");
  return violations.length === 0 ? { ok: true } : { ok: false, violations };
}

export function describeStaffPasswordViolations(
  violations: StaffPasswordViolation[],
  rules: StaffPasswordRules,
): string[] {
  return violations.map((v) =>
    v === "too_short"
      ? `Use at least ${rules.minLength} characters.`
      : `Use at most ${STAFF_PASSWORD_MAX_LENGTH} characters.`,
  );
}

// Unambiguous characters only (no 0/O, 1/l/I) so a temporary password read out or copied from a screen is not
// mistyped. 56 symbols x 16 characters is far beyond the policy minimum.
const TEMP_ALPHABET =
  "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";

/** Random temporary password that always satisfies the configured staff policy. */
export function generateStaffPassword(
  rules: StaffPasswordRules,
  random: (maxExclusive: number) => number = (n) => randomInt(n),
): string {
  const length = Math.min(
    Math.max(16, rules.minLength),
    STAFF_PASSWORD_MAX_LENGTH,
  );
  let out = "";
  for (let i = 0; i < length; i++)
    out += TEMP_ALPHABET[random(TEMP_ALPHABET.length)];
  return out;
}
