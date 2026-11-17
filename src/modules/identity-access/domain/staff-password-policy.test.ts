import { describe, expect, it } from "vitest";
import {
  describeStaffPasswordViolations,
  STAFF_PASSWORD_MAX_LENGTH,
  validateStaffPassword,
} from "./staff-password-policy";

const rules = { minLength: 12 };

describe("validateStaffPassword", () => {
  it("accepts exactly the minimum length", () => {
    expect(validateStaffPassword("a".repeat(12), rules)).toEqual({ ok: true });
  });

  it("rejects one character short, and a PIN-length password", () => {
    expect(validateStaffPassword("a".repeat(11), rules)).toEqual({
      ok: false,
      violations: ["too_short"],
    });
    expect(validateStaffPassword("482916", rules)).toEqual({
      ok: false,
      violations: ["too_short"],
    });
    expect(validateStaffPassword("", rules).ok).toBe(false);
  });

  it("counts characters, not UTF-16 units", () => {
    expect(validateStaffPassword("é".repeat(12), rules).ok).toBe(true);
    expect(validateStaffPassword("😀".repeat(11), rules).ok).toBe(false);
    expect(validateStaffPassword("😀".repeat(12), rules).ok).toBe(true);
  });

  it("honours a raised minimum", () => {
    expect(validateStaffPassword("a".repeat(14), { minLength: 16 }).ok).toBe(
      false,
    );
  });

  it("rejects absurdly long input", () => {
    expect(
      validateStaffPassword("a".repeat(STAFF_PASSWORD_MAX_LENGTH + 1), rules),
    ).toEqual({ ok: false, violations: ["too_long"] });
  });

  it("describes violations for the UI", () => {
    expect(describeStaffPasswordViolations(["too_short"], rules)).toEqual([
      "Use at least 12 characters.",
    ]);
  });
});
