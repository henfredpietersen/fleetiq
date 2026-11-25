import { describe, expect, it } from "vitest";
import fixture from "./validation.fixture.json";
import { evaluateChecks, routeOf, type ChecksInput } from "./validation";
import { lifetimeKm } from "./lifetime";
import { digitsOnly, parseReading, READING_MAX_KM } from "./reading-input";
import { odometerDbMessage, OD_MESSAGES } from "./odometer-errors";

type Case = (typeof fixture.cases)[number];

describe("evaluateChecks matches the SQL function (migration 053) through the shared vectors", () => {
  for (const c of fixture.cases as Case[]) {
    it(c.name, () => {
      const out = evaluateChecks(c.input as unknown as ChecksInput);
      expect(
        Object.fromEntries(out.checks.map((k) => [k.key, k.result])),
      ).toEqual(c.expect.results);
      expect(out.route).toBe(c.expect.route);
      const values = (
        c.expect as { values?: Record<string, Record<string, unknown>> }
      ).values;
      for (const [key, want] of Object.entries(values ?? {})) {
        const got = out.checks.find((k) => k.key === key)!.values;
        for (const [name, v] of Object.entries(want)) expect(got[name]).toBe(v);
      }
    });
  }

  it("every result value and both routes are covered by the vectors", () => {
    const results = new Set(
      (fixture.cases as Case[]).flatMap((c) => Object.values(c.expect.results)),
    );
    expect(results).toEqual(
      new Set(["pass", "fail", "waiting", "not_configured"]),
    );
    expect(
      new Set((fixture.cases as Case[]).map((c) => c.expect.route)),
    ).toEqual(new Set(["quick_check", "full"]));
  });

  it("routeOf: waiting and not_configured alone stay in the quick check; one fail goes to full review (DEC-44)", () => {
    expect(routeOf(["pass", "waiting", "not_configured"])).toBe("quick_check");
    expect(routeOf(["pass", "fail", "waiting"])).toBe("full");
  });

  it("the failed list names exactly the failed checks", () => {
    const out = evaluateChecks({
      stage: "pre_shift",
      driver_lifetime_km: 900,
      latest_accepted_lifetime_km: 1000,
      earlier_unaccepted_exists: false,
      pre_reading: null,
      previous_post: null,
      max_km_per_allocation: null,
      unaccounted_tolerance_km: 5,
      duplicate_image: true,
      capture_source: "in_app_camera",
      late_flag: false,
    });
    expect(out.failed).toEqual(["decreasing_reading", "duplicate_image"]);
  });
});

describe("lifetime km", () => {
  it("lifetime = displayed + offset", () => {
    expect(lifetimeKm(120, 50000)).toBe(50120);
    expect(lifetimeKm(120, 0)).toBe(120);
  });
});

describe("the driver's reading input (DEC-05, DEC-12)", () => {
  it("accepts whole kilometres 0 to 9,999,999", () => {
    expect(parseReading("0")).toEqual({ ok: true, km: 0 });
    expect(parseReading(" 123456 ")).toEqual({ ok: true, km: 123456 });
    expect(parseReading(String(READING_MAX_KM))).toEqual({
      ok: true,
      km: READING_MAX_KM,
    });
  });
  it("refuses blanks, decimals, signs, separators and 8 digits with a plain message", () => {
    for (const bad of [
      "",
      "  ",
      "12.5",
      "12,5",
      "-1",
      "+5",
      "1 000",
      "abc",
      "12km",
      "10000000",
    ]) {
      const r = parseReading(bad);
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.message.length).toBeGreaterThan(10);
    }
  });
  it("digitsOnly keeps digits and at most 7 of them", () => {
    expect(digitsOnly("12a3.4,5")).toBe("12345");
    expect(digitsOnly("123456789")).toBe("1234567");
  });
});

describe("odometer error messages", () => {
  it("every OD code has a plain-language message and the database's own message wins", () => {
    for (let n = 1; n <= 11; n++) {
      const code = `OD${String(n).padStart(3, "0")}`;
      expect(OD_MESSAGES[code], code).toBeTruthy();
      expect(odometerDbMessage({ code })).toBe(OD_MESSAGES[code]);
    }
    expect(
      odometerDbMessage({
        code: "OD006",
        hint: "user_message",
        message: "from the database",
      }),
    ).toBe("from the database");
    expect(odometerDbMessage({ code: "XX999" })).toMatch(
      /Something went wrong/,
    );
  });
});
