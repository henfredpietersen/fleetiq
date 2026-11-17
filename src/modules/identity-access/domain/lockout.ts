import type { LockoutConfig } from "./auth-config";

/** Counts supplied by the database (public.auth_login_counts). Timestamps are ISO strings or null. */
export type FailureCounts = {
  accountFailures: number;
  accountLastFailureAt: string | null;
  ipFailures: number;
  ipLastFailureAt: string | null;
};

export type LockoutDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason: "account" | "ip";
      retryAt: Date;
      retryAfterSeconds: number;
    };

const MIN = 60_000;

function blockedUntil(
  failures: number,
  lastAt: string | null,
  max: number,
  durationMin: number,
): Date | null {
  if (failures < max || lastAt === null) return null;
  return new Date(new Date(lastAt).getTime() + durationMin * MIN);
}

/**
 * Pure lockout decision. The ACCOUNT side is keyed by the hashed employee number, so a number that
 * does not exist is counted and locked exactly like one that does (non-disclosure).
 */
export function evaluateLockout(
  counts: FailureCounts,
  now: Date,
  cfg: LockoutConfig,
): LockoutDecision {
  const candidates: { reason: "account" | "ip"; until: Date }[] = [];
  const account = blockedUntil(
    counts.accountFailures,
    counts.accountLastFailureAt,
    cfg.accountMaxFailures,
    cfg.accountLockoutMinutes,
  );
  if (account && account > now)
    candidates.push({ reason: "account", until: account });
  const ip = blockedUntil(
    counts.ipFailures,
    counts.ipLastFailureAt,
    cfg.ipMaxFailures,
    cfg.ipBlockMinutes,
  );
  if (ip && ip > now) candidates.push({ reason: "ip", until: ip });
  if (candidates.length === 0) return { allowed: true };
  const worst = candidates.reduce((a, b) => (b.until > a.until ? b : a));
  return {
    allowed: false,
    reason: worst.reason,
    retryAt: worst.until,
    retryAfterSeconds: Math.max(
      1,
      Math.ceil((worst.until.getTime() - now.getTime()) / 1000),
    ),
  };
}

/** After recording a failed attempt: has this failure just pushed the account over the threshold? */
export function reachesAccountLockout(
  failuresBeforeThisOne: number,
  cfg: LockoutConfig,
): boolean {
  return failuresBeforeThisOne + 1 >= cfg.accountMaxFailures;
}

export function lockoutExpiry(now: Date, cfg: LockoutConfig): Date {
  return new Date(now.getTime() + cfg.accountLockoutMinutes * MIN);
}

export function formatRetry(seconds: number): string {
  const minutes = Math.ceil(seconds / 60);
  return minutes <= 1 ? "about a minute" : `${minutes} minutes`;
}
