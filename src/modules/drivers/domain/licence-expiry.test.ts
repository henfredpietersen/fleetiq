import { describe, expect, it } from "vitest";
import {
  daysUntil,
  licenceBadge,
  readWarningDays,
  sastToday,
} from "./licence-expiry";

const TODAY = "2026-11-17";

describe("sastToday", () => {
  it("uses the South African date, not UTC", () => {
    // 22:30 UTC on the 16th is 00:30 on the 17th in Johannesburg (UTC+2)
    expect(sastToday(new Date("2026-11-16T22:30:00Z"))).toBe("2026-11-17");
    expect(sastToday(new Date("2026-11-17T21:59:00Z"))).toBe("2026-11-17");
  });
});

describe("daysUntil", () => {
  it("counts whole calendar days, across month ends", () => {
    expect(daysUntil("2026-11-17", TODAY)).toBe(0);
    expect(daysUntil("2026-12-17", TODAY)).toBe(30);
    expect(daysUntil("2026-11-16", TODAY)).toBe(-1);
  });
});

describe("licenceBadge", () => {
  const verified = { prdpExpiry: null, verification: "verified" };

  it("shows nothing recorded when there is no licence", () => {
    expect(
      licenceBadge(
        { licenceExpiry: null, prdpExpiry: null, verification: null },
        TODAY,
      ),
    ).toEqual({
      state: "none",
      label: "No licence recorded",
    });
  });

  it("expired is the day after the expiry date (the expiry day itself still counts)", () => {
    expect(
      licenceBadge({ ...verified, licenceExpiry: "2026-11-16" }, TODAY).state,
    ).toBe("expired");
    expect(
      licenceBadge({ ...verified, licenceExpiry: "2026-11-17" }, TODAY),
    ).toEqual({
      state: "expiring",
      label: "Licence expires today",
    });
  });

  it("warns inside the window and not outside it", () => {
    expect(
      licenceBadge({ ...verified, licenceExpiry: "2026-12-17" }, TODAY).state,
    ).toBe("expiring"); // 30 days
    expect(
      licenceBadge({ ...verified, licenceExpiry: "2026-12-18" }, TODAY).state,
    ).toBe("valid"); // 31 days
    expect(
      licenceBadge({ ...verified, licenceExpiry: "2026-12-18" }, TODAY, 60)
        .state,
    ).toBe("expiring");
  });

  it("checks the PrDP as well as the licence, and expired beats expiring", () => {
    expect(
      licenceBadge(
        {
          licenceExpiry: "2028-01-01",
          prdpExpiry: "2026-11-01",
          verification: "verified",
        },
        TODAY,
      ),
    ).toEqual({ state: "expired", label: "PrDP expired 2026-11-01" });
    expect(
      licenceBadge(
        {
          licenceExpiry: "2026-11-20",
          prdpExpiry: "2026-11-01",
          verification: "verified",
        },
        TODAY,
      ).state,
    ).toBe("expired");
  });

  it("flags an unverified licence that is otherwise in date", () => {
    expect(
      licenceBadge(
        {
          licenceExpiry: "2028-01-01",
          prdpExpiry: null,
          verification: "recorded",
        },
        TODAY,
      ),
    ).toEqual({
      state: "unverified",
      label: "Licence not yet verified",
    });
  });

  it("is valid only when in date and verified", () => {
    expect(
      licenceBadge({ ...verified, licenceExpiry: "2028-01-01" }, TODAY),
    ).toEqual({
      state: "valid",
      label: "Licence valid",
    });
  });
});

describe("readWarningDays", () => {
  it("defaults to 30, reads an override, and fails loudly on nonsense", () => {
    expect(readWarningDays({})).toBe(30);
    expect(readWarningDays({ LICENCE_EXPIRY_WARNING_DAYS: "60" })).toBe(60);
    expect(() =>
      readWarningDays({ LICENCE_EXPIRY_WARNING_DAYS: "0" }),
    ).toThrow();
    expect(() =>
      readWarningDays({ LICENCE_EXPIRY_WARNING_DAYS: "soon" }),
    ).toThrow();
  });
});
