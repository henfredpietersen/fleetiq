import "server-only";
import type { IssuePinInput, IssuePinResult } from "../domain/driver-auth";
import { createDriverAuth } from "./factory";

/**
 * Reviewed server-only admin function (ARCH §5.1/§5.3): issue or reset a driver's PIN.
 * Deliberately NOT a "use server" action — it cannot be invoked from the browser. A future admin screen
 * must call it from its own server action after its own route-level checks. It requires driver.manage in
 * the driver's branch scope (via has_permission, which also demands AAL2 for approvers/admins), refuses
 * self-service (DEC-24), and returns the PIN once; it is never stored or logged.
 */
export async function issueDriverPin(
  input: IssuePinInput,
): Promise<IssuePinResult> {
  const driverAuth = await createDriverAuth();
  return driverAuth.issuePin(input);
}
