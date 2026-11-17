import { describe, expect, it } from "vitest";
import { DEFAULT_AUTH_CONFIG } from "./auth-config";
import {
  createSessionStartValue,
  isSessionExpired,
  maxAgeMs,
  readSessionStartValue,
} from "./session-policy";

const secret = "k".repeat(40);
const user = "u-1";
const t0 = new Date("2026-11-17T06:00:00.000Z");
const cfg = DEFAULT_AUTH_CONFIG.session;
const plus = (h: number) => new Date(t0.getTime() + h * 3_600_000);

describe("session start cookie", () => {
  it("round-trips", () => {
    const v = createSessionStartValue(secret, user, "driver", t0);
    expect(readSessionStartValue(secret, user, v)).toEqual({
      kind: "driver",
      startedAtMs: t0.getTime(),
    });
  });

  it("rejects missing, malformed, forged, re-targeted and re-typed values", () => {
    const v = createSessionStartValue(secret, user, "staff", t0);
    expect(readSessionStartValue(secret, user, undefined)).toBeNull();
    expect(readSessionStartValue(secret, user, "garbage")).toBeNull();
    expect(readSessionStartValue(secret, "someone-else", v)).toBeNull();
    expect(readSessionStartValue("z".repeat(40), user, v)).toBeNull();
    // extending the start time or changing the user type invalidates the signature
    const [, ms, sig] = v.split(".");
    expect(
      readSessionStartValue(
        secret,
        user,
        `staff.${Number(ms) + 3_600_000}.${sig}`,
      ),
    ).toBeNull();
    expect(
      readSessionStartValue(secret, user, `driver.${ms}.${sig}`),
    ).toBeNull();
    expect(readSessionStartValue(secret, user, `staff.${ms}.zz`)).toBeNull();
  });
});

describe("absolute session expiry per user type", () => {
  it("office users expire sooner than company-phone drivers", () => {
    expect(maxAgeMs("staff", cfg)).toBeLessThan(maxAgeMs("driver", cfg));
    const staff = { kind: "staff" as const, startedAtMs: t0.getTime() };
    const driver = { kind: "driver" as const, startedAtMs: t0.getTime() };
    expect(isSessionExpired(staff, plus(11.9), cfg)).toBe(false);
    expect(isSessionExpired(staff, plus(12), cfg)).toBe(true);
    expect(isSessionExpired(driver, plus(12), cfg)).toBe(false);
    expect(isSessionExpired(driver, plus(335), cfg)).toBe(false);
    expect(isSessionExpired(driver, plus(336), cfg)).toBe(true);
  });

  it("is configurable and treats a start in the future as invalid", () => {
    const short = { driverMaxAgeHours: 1, staffMaxAgeHours: 1 };
    expect(
      isSessionExpired(
        { kind: "driver", startedAtMs: t0.getTime() },
        plus(1),
        short,
      ),
    ).toBe(true);
    expect(
      isSessionExpired(
        { kind: "driver", startedAtMs: plus(5).getTime() },
        t0,
        cfg,
      ),
    ).toBe(true);
  });
});
