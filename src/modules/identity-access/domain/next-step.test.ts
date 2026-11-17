import { describe, expect, it } from "vitest";
import { nextAuthStep } from "./next-step";

describe("nextAuthStep", () => {
  it("a forced PIN change always comes first", () => {
    expect(
      nextAuthStep({ mustChangePin: true, requiresMfa: true, aal: "aal1" }),
    ).toBe("/change-pin");
    expect(
      nextAuthStep({ mustChangePin: true, requiresMfa: false, aal: "aal1" }),
    ).toBe("/change-pin");
  });
  it("MFA-required users stay at /mfa until AAL2", () => {
    expect(
      nextAuthStep({ mustChangePin: false, requiresMfa: true, aal: "aal1" }),
    ).toBe("/mfa");
    expect(
      nextAuthStep({ mustChangePin: false, requiresMfa: true, aal: "aal2" }),
    ).toBe("/home");
  });
  it("everyone else goes straight home", () => {
    expect(
      nextAuthStep({ mustChangePin: false, requiresMfa: false, aal: "aal1" }),
    ).toBe("/home");
  });
  it("a staff member's forced change goes to the password page, a driver's to the PIN page", () => {
    expect(
      nextAuthStep({
        userType: "staff",
        mustChangePin: true,
        requiresMfa: true,
        aal: "aal1",
      }),
    ).toBe("/change-password");
    expect(
      nextAuthStep({
        userType: "driver",
        mustChangePin: true,
        requiresMfa: false,
        aal: "aal1",
      }),
    ).toBe("/change-pin");
  });
  it("after the staff password is changed, MFA enrolment/verification comes next (DEC-34)", () => {
    expect(
      nextAuthStep({
        userType: "staff",
        mustChangePin: false,
        requiresMfa: true,
        aal: "aal1",
      }),
    ).toBe("/mfa");
  });
});
