// DriverAuth: the seam behind which AD-08 (Proposed) is implemented. If the architecture decision
// changes (e.g. a different identity mechanism), only the implementation changes — screens and
// actions depend on this interface. DEC-08 (employee number + PIN) is the approved requirement.

import type { PinViolation } from "./pin-rules";

export type DriverSignInInput = {
  employeeNumber: string;
  pin: string;
  /** Client IP as seen by the server (for per-IP rate limiting). */
  ip: string;
};

export type DriverSignInResult =
  | { ok: true; next: "/change-pin" | "/home" }
  // One undifferentiated failure for "no such number", "wrong PIN", disabled and wrong user type.
  | { ok: false; code: "invalid_credentials" }
  | { ok: false; code: "locked"; retryAfterSeconds: number }
  | { ok: false; code: "service_error" };

export type ChangePinResult =
  | { ok: true }
  | { ok: false; code: "weak_pin"; violations: PinViolation[] }
  | { ok: false; code: "same_pin" }
  | { ok: false; code: "not_driver" }
  | { ok: false; code: "service_error" };

export type IssuePinInput = {
  targetProfileId: string;
  mode: "issue" | "reset";
};

export type IssuePinResult =
  // The PIN is returned exactly once to the caller and is never stored or logged (DEC-24 / ARCH §5.1).
  | { ok: true; pin: string }
  | {
      ok: false;
      code:
        | "unauthenticated"
        | "mfa_required"
        | "forbidden"
        | "not_found"
        | "self_reset"
        | "service_error";
    };

export interface DriverAuth {
  signIn(input: DriverSignInInput): Promise<DriverSignInResult>;
  /** Changes the PIN of the CURRENT session's driver and clears the forced-change flag. */
  changePin(input: { newPin: string }): Promise<ChangePinResult>;
  /** Reviewed admin path: requires driver.manage in the driver's scope; never your own PIN. */
  issuePin(input: IssuePinInput): Promise<IssuePinResult>;
}
