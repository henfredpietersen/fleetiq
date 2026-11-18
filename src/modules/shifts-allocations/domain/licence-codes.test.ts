import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import fixture from "./licence-code-coverage.fixture.json";
import {
  isLicenceCode,
  LICENCE_CODES,
  licenceCodeCovers,
} from "./licence-codes";

describe("licenceCodeCovers (regulation 99; mirror of licence_code_coverage)", () => {
  it("knows exactly the eight codes, in the fixture's order", () => {
    expect([...LICENCE_CODES]).toEqual(fixture.codes);
  });

  it("matches the shared fixture for all 64 pairs", () => {
    let n = 0;
    for (const required of fixture.codes) {
      for (const held of fixture.codes) {
        const want = (fixture.covers as Record<string, string[]>)[
          required
        ]!.includes(held);
        expect(
          licenceCodeCovers(held, required),
          `${held} vs ${required}`,
        ).toBe(want);
        n++;
      }
    }
    expect(n).toBe(64);
  });

  it("a code always covers itself", () => {
    for (const c of LICENCE_CODES) expect(licenceCodeCovers(c, c)).toBe(true);
  });

  it("nulls, empty and unknown codes cover nothing", () => {
    expect(licenceCodeCovers(null, "B")).toBe(false);
    expect(licenceCodeCovers("B", null)).toBe(false);
    expect(licenceCodeCovers(undefined, undefined)).toBe(false);
    expect(licenceCodeCovers("XX", "XX")).toBe(false);
    expect(licenceCodeCovers("b", "B")).toBe(false);
    expect(licenceCodeCovers("", "")).toBe(false);
    expect(isLicenceCode("EC1")).toBe(true);
    expect(isLicenceCode("D")).toBe(false);
  });

  it("the generated pgTAP file asserts the same 64 results (SQL and TS come from one fixture)", () => {
    const sql = readFileSync(
      new URL(
        "../../../../supabase/tests/database/phase3b_licence_code_coverage.test.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const re =
      /licence_code_coverage\('(\w+)', '(\w+)'\), (true|false), 'held \w+ vs required \w+: /g;
    const found = [...sql.matchAll(re)];
    expect(found).toHaveLength(64);
    for (const [, held, required, covers] of found) {
      expect(licenceCodeCovers(held, required), `${held} vs ${required}`).toBe(
        covers === "true",
      );
    }
  });
});
