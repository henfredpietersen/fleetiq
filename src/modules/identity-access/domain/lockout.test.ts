import { describe, expect, it } from "vitest";
import { DEFAULT_AUTH_CONFIG } from "./auth-config";
import {
  evaluateLockout,
  formatRetry,
  lockoutExpiry,
  reachesAccountLockout,
  type FailureCounts,
} from "./lockout";

const cfg = DEFAULT_AUTH_CONFIG.lockout; // 5 account / 20 ip failures, 15-minute lockouts
const now = new Date("2026-11-17T10:00:00.000Z");
const ago = (min: number) =>
  new Date(now.getTime() - min * 60_000).toISOString();
const none: FailureCounts = {
  accountFailures: 0,
  accountLastFailureAt: null,
  ipFailures: 0,
  ipLastFailureAt: null,
};

describe("evaluateLockout", () => {
  it("allows when below both thresholds", () => {
    expect(
      evaluateLockout(
        {
          ...none,
          accountFailures: 4,
          accountLastFailureAt: ago(1),
          ipFailures: 19,
          ipLastFailureAt: ago(1),
        },
        now,
        cfg,
      ),
    ).toEqual({ allowed: true });
  });

  it("locks the account at the threshold until last failure + lockout duration", () => {
    const d = evaluateLockout(
      { ...none, accountFailures: 5, accountLastFailureAt: ago(5) },
      now,
      cfg,
    );
    expect(d.allowed).toBe(false);
    if (!d.allowed) {
      expect(d.reason).toBe("account");
      expect(d.retryAt.toISOString()).toBe("2026-11-17T10:10:00.000Z");
      expect(d.retryAfterSeconds).toBe(600);
    }
  });

  it("unlocks exactly when the lockout elapses", () => {
    expect(
      evaluateLockout(
        { ...none, accountFailures: 5, accountLastFailureAt: ago(15) },
        now,
        cfg,
      ).allowed,
    ).toBe(true);
    expect(
      evaluateLockout(
        { ...none, accountFailures: 5, accountLastFailureAt: ago(14.9) },
        now,
        cfg,
      ).allowed,
    ).toBe(false);
  });

  it("blocks a noisy IP independently of any account", () => {
    const d = evaluateLockout(
      { ...none, ipFailures: 20, ipLastFailureAt: ago(1) },
      now,
      cfg,
    );
    expect(d).toMatchObject({ allowed: false, reason: "ip" });
  });

  it("reports the longer of two concurrent blocks", () => {
    const d = evaluateLockout(
      {
        accountFailures: 5,
        accountLastFailureAt: ago(10),
        ipFailures: 20,
        ipLastFailureAt: ago(1),
      },
      now,
      cfg,
    );
    expect(d).toMatchObject({
      allowed: false,
      reason: "ip",
      retryAfterSeconds: 14 * 60,
    });
  });

  it("never reports less than one second", () => {
    const d = evaluateLockout(
      {
        ...none,
        accountFailures: 5,
        accountLastFailureAt: new Date(
          now.getTime() - 15 * 60_000 + 10,
        ).toISOString(),
      },
      now,
      cfg,
    );
    expect(d).toMatchObject({ allowed: false, retryAfterSeconds: 1 });
  });

  it("honours custom thresholds", () => {
    const custom = { ...cfg, accountMaxFailures: 3, accountLockoutMinutes: 60 };
    const d = evaluateLockout(
      { ...none, accountFailures: 3, accountLastFailureAt: ago(30) },
      now,
      custom,
    );
    expect(d).toMatchObject({ allowed: false, retryAfterSeconds: 30 * 60 });
  });

  it("a failure count without a timestamp cannot block (defensive)", () => {
    expect(
      evaluateLockout({ ...none, accountFailures: 99 }, now, cfg).allowed,
    ).toBe(true);
  });
});

describe("lockout helpers", () => {
  it("the failure that reaches the threshold triggers the lockout", () => {
    expect(reachesAccountLockout(3, cfg)).toBe(false);
    expect(reachesAccountLockout(4, cfg)).toBe(true);
    expect(reachesAccountLockout(9, cfg)).toBe(true);
  });
  it("computes the expiry", () => {
    expect(lockoutExpiry(now, cfg).toISOString()).toBe(
      "2026-11-17T10:15:00.000Z",
    );
  });
  it("formats retry hints", () => {
    expect(formatRetry(30)).toBe("about a minute");
    expect(formatRetry(60)).toBe("about a minute");
    expect(formatRetry(61)).toBe("2 minutes");
    expect(formatRetry(900)).toBe("15 minutes");
  });
});
