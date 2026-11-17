import { describe, expect, it } from "vitest";
import {
  clientIpFromHeaders,
  deriveLoginIdentifier,
  hashEmployeeNumber,
  hashIp,
  INTERNAL_EMAIL_DOMAIN,
  isInternalIdentifier,
  normalizeEmployeeNumber,
} from "./identifiers";

const secret = "s".repeat(40);
const company = "11111111-1111-4111-8111-111111111111";

describe("identifiers", () => {
  it("normalises employee numbers (case, spaces, unicode) and rejects junk", () => {
    expect(normalizeEmployeeNumber("  e-1001 ")).toBe("E-1001");
    expect(normalizeEmployeeNumber("ＥＭＰ１")).toBe("EMP1");
    for (const bad of [
      "",
      "   ",
      "-1",
      "a b",
      "x".repeat(21),
      "e1001;drop",
      "é1",
    ]) {
      expect(normalizeEmployeeNumber(bad)).toBeNull();
    }
  });

  it("derives a stable, non-deliverable login identifier", () => {
    const id = deriveLoginIdentifier(secret, company, "E1001");
    expect(id).toBe(deriveLoginIdentifier(secret, company, "E1001"));
    expect(id).toMatch(
      new RegExp(
        `^d-[0-9a-f]{40}@${INTERNAL_EMAIL_DOMAIN.replace(/\./g, "\\.")}$`,
      ),
    );
    expect(id).not.toContain("E1001");
    expect(isInternalIdentifier(id)).toBe(true);
    expect(isInternalIdentifier("someone@example.com")).toBe(false);
  });

  it("depends on secret, company and number", () => {
    const base = deriveLoginIdentifier(secret, company, "E1001");
    expect(deriveLoginIdentifier("t".repeat(40), company, "E1001")).not.toBe(
      base,
    );
    expect(
      deriveLoginIdentifier(
        secret,
        "22222222-2222-4222-8222-222222222222",
        "E1001",
      ),
    ).not.toBe(base);
    expect(deriveLoginIdentifier(secret, company, "E1002")).not.toBe(base);
  });

  it("hashes are 64-hex, never the raw value, and purpose-separated", () => {
    const e = hashEmployeeNumber(secret, company, "E1001");
    const i = hashIp(secret, "203.0.113.9");
    expect(e).toMatch(/^[0-9a-f]{64}$/);
    expect(i).toMatch(/^[0-9a-f]{64}$/);
    expect(e).not.toContain("E1001");
    expect(hashIp(secret, "E1001")).not.toBe(
      hashEmployeeNumber(secret, company, "E1001"),
    );
    expect(hashIp(secret, "203.0.113.9")).toBe(i);
  });

  it("refuses a weak or missing secret", () => {
    expect(() => hashIp("short", "1.2.3.4")).toThrow(/at least 32/);
    expect(() => deriveLoginIdentifier("", company, "E1")).toThrow();
  });

  it("takes the first forwarded IP and falls back to a shared bucket", () => {
    const h = (m: Record<string, string>) => (n: string) => m[n] ?? null;
    expect(
      clientIpFromHeaders(h({ "x-forwarded-for": "198.51.100.1, 10.0.0.1" })),
    ).toBe("198.51.100.1");
    expect(clientIpFromHeaders(h({ "x-real-ip": "198.51.100.2" }))).toBe(
      "198.51.100.2",
    );
    expect(clientIpFromHeaders(h({}))).toBe("unknown");
  });
});
