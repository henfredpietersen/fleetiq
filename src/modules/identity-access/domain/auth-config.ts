// Sign-in policy as configuration (ARCH §5.1: PIN rules, lockout thresholds and session expiry are
// configurable). Every value below is a PROPOSED default, not an approved decision — change via env.

import {
  STAFF_PASSWORD_MAX_LENGTH,
  STAFF_PASSWORD_MIN_FLOOR,
  type StaffPasswordRules,
} from "./staff-password-policy";

export type PinRules = {
  /** Number of digits. Supabase's minimum_password_length must be <= this value. */
  length: number;
  /** Reject ascending/descending runs such as 123456, 654321, 890123. */
  blockSequences: boolean;
  /** Reject all-same digits and repeated blocks such as 111111, 121212, 123123. */
  blockRepeats: boolean;
};

export type LockoutConfig = {
  /** Failures for one employee number within `windowMinutes` that trigger a lockout. */
  accountMaxFailures: number;
  /** Failures from one IP within `windowMinutes` that block that IP. */
  ipMaxFailures: number;
  windowMinutes: number;
  accountLockoutMinutes: number;
  ipBlockMinutes: number;
};

export type SessionConfig = {
  /** Absolute session lifetime per user type, in hours. Company phones: long. Office users: short. */
  driverMaxAgeHours: number;
  staffMaxAgeHours: number;
};

export type AuthConfig = {
  pin: PinRules;
  /** Staff password rules (carry-over C3). Supabase's own minimum (6) is never relied on for staff. */
  staffPassword: StaffPasswordRules;
  lockout: LockoutConfig;
  session: SessionConfig;
};

export const DEFAULT_AUTH_CONFIG: AuthConfig = {
  pin: { length: 6, blockSequences: true, blockRepeats: true },
  staffPassword: { minLength: STAFF_PASSWORD_MIN_FLOOR },
  lockout: {
    accountMaxFailures: 5,
    ipMaxFailures: 20,
    windowMinutes: 15,
    accountLockoutMinutes: 15,
    ipBlockMinutes: 15,
  },
  session: { driverMaxAgeHours: 336, staffMaxAgeHours: 12 },
};

type Env = Record<string, string | undefined>;

function int(
  env: Env,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${key} must be an integer between ${min} and ${max}`);
  }
  return n;
}

function bool(env: Env, key: string, fallback: boolean): boolean {
  const raw = env[key]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return fallback;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  throw new Error(`${key} must be true or false`);
}

/** Reads the policy from env; invalid values fail loudly instead of silently weakening security. */
export function loadAuthConfig(env: Env = process.env): AuthConfig {
  const d = DEFAULT_AUTH_CONFIG;
  return {
    pin: {
      length: int(env, "AUTH_PIN_LENGTH", d.pin.length, 6, 12),
      blockSequences: bool(
        env,
        "AUTH_PIN_BLOCK_SEQUENCES",
        d.pin.blockSequences,
      ),
      blockRepeats: bool(env, "AUTH_PIN_BLOCK_REPEATS", d.pin.blockRepeats),
    },
    staffPassword: {
      // Floor 12: the setting can be raised, but a value below 12 fails loudly rather than weakening staff auth.
      minLength: int(
        env,
        "AUTH_STAFF_PASSWORD_MIN_LENGTH",
        d.staffPassword.minLength,
        STAFF_PASSWORD_MIN_FLOOR,
        STAFF_PASSWORD_MAX_LENGTH,
      ),
    },
    lockout: {
      accountMaxFailures: int(
        env,
        "AUTH_LOCK_ACCOUNT_MAX_FAILURES",
        d.lockout.accountMaxFailures,
        3,
        100,
      ),
      ipMaxFailures: int(
        env,
        "AUTH_LOCK_IP_MAX_FAILURES",
        d.lockout.ipMaxFailures,
        3,
        1000,
      ),
      windowMinutes: int(
        env,
        "AUTH_LOCK_WINDOW_MINUTES",
        d.lockout.windowMinutes,
        1,
        1440,
      ),
      accountLockoutMinutes: int(
        env,
        "AUTH_LOCK_ACCOUNT_MINUTES",
        d.lockout.accountLockoutMinutes,
        1,
        10080,
      ),
      ipBlockMinutes: int(
        env,
        "AUTH_LOCK_IP_MINUTES",
        d.lockout.ipBlockMinutes,
        1,
        10080,
      ),
    },
    session: {
      driverMaxAgeHours: int(
        env,
        "AUTH_SESSION_DRIVER_HOURS",
        d.session.driverMaxAgeHours,
        1,
        8760,
      ),
      staffMaxAgeHours: int(
        env,
        "AUTH_SESSION_STAFF_HOURS",
        d.session.staffMaxAgeHours,
        1,
        8760,
      ),
    },
  };
}
