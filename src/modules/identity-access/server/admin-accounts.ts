import "server-only";
import type { CreateDriverInput, CreateDriverResult } from "./driver-accounts";
import { createDriverAccounts, createStaffAccounts } from "./factory";
import type {
  CreateStaffUserResult,
  SetStaffPasswordResult,
} from "./staff-accounts";

/**
 * Reviewed server-only admin entry points for account administration (ARCH §5.1/§5.3). Deliberately NOT a
 * "use server" module: nothing here can be invoked from the browser. A screen's own server action calls these
 * after its route-level checks and zod validation. Each one authorises the signed-in caller itself
 * (driver.manage / users.roles.manage via has_permission), uses the service-role key only inside the reviewed
 * classes, and leaves audit rows through the database triggers. Driver PIN reset is `issueDriverPin` (admin-pin.ts).
 */
export async function createDriverAccount(
  input: CreateDriverInput,
): Promise<CreateDriverResult> {
  return (await createDriverAccounts()).createDriver(input);
}

export async function createStaffAccount(input: {
  email: string;
  displayName: string;
}): Promise<CreateStaffUserResult> {
  return (await createStaffAccounts()).createStaffUser(input);
}

export async function resetStaffPassword(input: {
  targetUserId: string;
  newPassword: string;
}): Promise<SetStaffPasswordResult> {
  return (await createStaffAccounts()).resetStaffPassword(input);
}
