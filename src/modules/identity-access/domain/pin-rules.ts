import { randomInt } from "node:crypto";
import type { PinRules } from "./auth-config";

export type PinViolation =
  "not_digits" | "wrong_length" | "sequence" | "repeat";

export type PinCheck = { ok: true } | { ok: false; violations: PinViolation[] };

/** Smallest period p (1 <= p <= len/2, p divides len) such that the PIN is one block repeated. */
function repeatedBlock(pin: string): boolean {
  const n = pin.length;
  for (let p = 1; p <= n / 2; p++) {
    if (n % p === 0 && pin.slice(0, p).repeat(n / p) === pin) return true;
  }
  return false;
}

/** Every step is +1 (or every step is -1) modulo 10, so 890123 and 321098 count as sequences. */
function isSequence(pin: string): boolean {
  const d = [...pin].map(Number);
  if (d.length < 2) return false;
  const steps = d.slice(1).map((x, i) => (x - d[i] + 10) % 10);
  return steps.every((s) => s === 1) || steps.every((s) => s === 9);
}

export function validatePin(pin: string, rules: PinRules): PinCheck {
  if (!/^\d+$/.test(pin)) return { ok: false, violations: ["not_digits"] };
  const violations: PinViolation[] = [];
  if (pin.length !== rules.length) violations.push("wrong_length");
  if (rules.blockSequences && isSequence(pin)) violations.push("sequence");
  if (rules.blockRepeats && repeatedBlock(pin)) violations.push("repeat");
  return violations.length === 0 ? { ok: true } : { ok: false, violations };
}

export function describePinViolations(
  violations: PinViolation[],
  rules: PinRules,
): string[] {
  const text: Record<PinViolation, string> = {
    not_digits: "Use digits only.",
    wrong_length: `Use exactly ${rules.length} digits.`,
    sequence: "Avoid sequences such as 123456 or 654321.",
    repeat: "Avoid repeated digits or patterns such as 111111 or 121212.",
  };
  return violations.map((v) => text[v]);
}

/** Cryptographically random PIN that satisfies the rules (rejection sampling). */
export function generatePin(
  rules: PinRules,
  random: (maxExclusive: number) => number = (n) => randomInt(n),
): string {
  for (let attempt = 0; attempt < 10_000; attempt++) {
    let pin = "";
    for (let i = 0; i < rules.length; i++) pin += String(random(10));
    if (validatePin(pin, rules).ok) return pin;
  }
  throw new Error(
    "could not generate a PIN that satisfies the configured rules",
  );
}
