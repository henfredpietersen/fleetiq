import { describe, expect, it } from "vitest";
import { DEFAULT_AUTH_CONFIG, loadAuthConfig } from "./auth-config";

describe("loadAuthConfig", () => {
  it("returns the proposed defaults when nothing is set", () => {
    expect(loadAuthConfig({})).toEqual(DEFAULT_AUTH_CONFIG);
    expect(DEFAULT_AUTH_CONFIG.pin.length).toBe(6);
  });

  it("reads overrides from env", () => {
    const c = loadAuthConfig({
      AUTH_PIN_LENGTH: "8",
      AUTH_PIN_BLOCK_SEQUENCES: "false",
      AUTH_LOCK_ACCOUNT_MAX_FAILURES: "3",
      AUTH_LOCK_ACCOUNT_MINUTES: "60",
      AUTH_SESSION_DRIVER_HOURS: "72",
      AUTH_SESSION_STAFF_HOURS: "8",
    });
    expect(c.pin).toEqual({
      length: 8,
      blockSequences: false,
      blockRepeats: true,
    });
    expect(c.lockout.accountMaxFailures).toBe(3);
    expect(c.lockout.accountLockoutMinutes).toBe(60);
    expect(c.session).toEqual({ driverMaxAgeHours: 72, staffMaxAgeHours: 8 });
  });

  it("fails loudly on values that would weaken security or are malformed", () => {
    expect(() => loadAuthConfig({ AUTH_PIN_LENGTH: "4" })).toThrow(
      /AUTH_PIN_LENGTH/,
    );
    expect(() =>
      loadAuthConfig({ AUTH_LOCK_ACCOUNT_MAX_FAILURES: "1" }),
    ).toThrow(/AUTH_LOCK_ACCOUNT_MAX_FAILURES/);
    expect(() => loadAuthConfig({ AUTH_LOCK_WINDOW_MINUTES: "abc" })).toThrow();
    expect(() => loadAuthConfig({ AUTH_PIN_BLOCK_REPEATS: "maybe" })).toThrow(
      /true or false/,
    );
  });
});
