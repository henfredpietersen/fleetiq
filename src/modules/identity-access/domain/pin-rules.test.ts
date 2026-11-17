import { describe, expect, it } from "vitest";
import { DEFAULT_AUTH_CONFIG } from "./auth-config";
import { describePinViolations, generatePin, validatePin } from "./pin-rules";

const rules = DEFAULT_AUTH_CONFIG.pin;

describe("validatePin (default: 6 digits, no trivial sequences/repeats)", () => {
  it.each(["482916", "073519", "908172", "135790"])("accepts %s", (pin) => {
    expect(validatePin(pin, rules)).toEqual({ ok: true });
  });

  it.each([
    ["000000", "repeat"],
    ["111111", "repeat"],
    ["121212", "repeat"],
    ["123123", "repeat"],
    ["112112", "repeat"],
    ["123456", "sequence"],
    ["234567", "sequence"],
    ["654321", "sequence"],
    ["890123", "sequence"],
    ["321098", "sequence"],
  ])("rejects trivial PIN %s as %s", (pin, why) => {
    const r = validatePin(pin, rules);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.violations).toContain(why);
  });

  it("rejects wrong length and non-digits", () => {
    expect(validatePin("48291", rules)).toEqual({
      ok: false,
      violations: ["wrong_length"],
    });
    expect(validatePin("4829167", rules)).toEqual({
      ok: false,
      violations: ["wrong_length"],
    });
    expect(validatePin("48a916", rules)).toEqual({
      ok: false,
      violations: ["not_digits"],
    });
    expect(validatePin("", rules)).toEqual({
      ok: false,
      violations: ["not_digits"],
    });
    expect(validatePin("48 916", rules)).toEqual({
      ok: false,
      violations: ["not_digits"],
    });
  });

  it("is configurable: length, sequences and repeats can be switched", () => {
    expect(
      validatePin("12345678", {
        length: 8,
        blockSequences: true,
        blockRepeats: true,
      }).ok,
    ).toBe(false);
    expect(
      validatePin("12345678", {
        length: 8,
        blockSequences: false,
        blockRepeats: true,
      }).ok,
    ).toBe(true);
    expect(validatePin("111111", { ...rules, blockRepeats: false }).ok).toBe(
      true,
    );
    expect(validatePin("482916", { ...rules, length: 8 })).toEqual({
      ok: false,
      violations: ["wrong_length"],
    });
  });

  it("explains violations in plain language", () => {
    const text = describePinViolations(
      ["wrong_length", "sequence"],
      rules,
    ).join(" ");
    expect(text).toContain("6 digits");
    expect(text).toContain("sequences");
  });
});

describe("generatePin", () => {
  it("always satisfies the rules", () => {
    for (let i = 0; i < 300; i++)
      expect(validatePin(generatePin(rules), rules).ok).toBe(true);
  });

  it("skips rule-breaking random draws", () => {
    // first draw would be 000000, second 482916
    const draws = [...Array(6).fill(0), 4, 8, 2, 9, 1, 6];
    let i = 0;
    expect(generatePin(rules, () => draws[i++]!)).toBe("482916");
  });
});
