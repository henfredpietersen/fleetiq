import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import type { AuthConfig } from "../domain/auth-config";
import {
  deriveLoginIdentifier,
  normalizeEmployeeNumber,
} from "../domain/identifiers";
import { generatePin } from "../domain/pin-rules";

/**
 * Reviewed admin function (ARCH §5.1/§5.3): create a driver account — Supabase Auth user (internal login
 * identifier, AD-08, no real email), profile, drivers row and the driver role — in one flow.
 *
 *   1. authorise: a signed-in caller holding driver.manage in THIS branch (has_permission, at AAL2 when their
 *      roles require MFA). admin_create_driver() re-checks the same permission for the caller itself.
 *   2. create the Auth user with a generated temporary PIN (rules from config: 6 digits, no sequences/repeats).
 *   3. admin_create_driver(): profile + driver + role + PIN-issue flags in ONE database transaction.
 *   4. if step 3 fails the Auth user is deleted again, so no orphan account is left (DEC-08 needs every driver
 *      to be a real, signed-in account; an Auth user without a driver is never acceptable).
 * The PIN is returned once, to the issuer, only on success. It is never stored or logged, and the profile is
 * created with must_change_pin = true, so access_cleared() is false until the driver changes it (DEC-24, 1B).
 * Deliberately NOT a "use server" module: it cannot be invoked from the browser.
 */

export type CreateDriverInput = {
  branchId: string;
  employeeNumber: string;
  displayName: string;
  phone?: string;
};

export type CreateDriverResult =
  | { ok: true; driverId: string; userId: string; pin: string }
  | {
      ok: false;
      code:
        | "unauthenticated"
        | "mfa_required"
        | "forbidden"
        | "invalid_employee_number"
        | "invalid_input"
        | "employee_number_taken"
        | "service_error";
    }
  // Database step failed and the Auth user could not be removed: an operator must delete it.
  | { ok: false; code: "rollback_failed"; orphanUserId: string };

export type DriverAccountsDeps = {
  /** Service-role client: reviewed admin function only. */
  admin: SupabaseClient<Database>;
  /** The caller's own session client. */
  userClient: SupabaseClient<Database>;
  config: Pick<AuthConfig, "pin">;
  secret: string;
};

export class DriverAccounts {
  constructor(private readonly d: DriverAccountsDeps) {}

  async createDriver(input: CreateDriverInput): Promise<CreateDriverResult> {
    const { admin, userClient, config, secret } = this.d;

    const employeeNumber = normalizeEmployeeNumber(input.employeeNumber);
    if (!employeeNumber) return { ok: false, code: "invalid_employee_number" };
    const displayName = input.displayName.trim();
    if (!displayName || displayName.length > 200)
      return { ok: false, code: "invalid_input" };

    const { data: userData } = await userClient.auth.getUser();
    const caller = userData.user;
    if (!caller) return { ok: false, code: "unauthenticated" };

    // DEC-34: approvers/administrators must be at AAL2 (has_permission below also enforces it).
    const { data: requiresMfa } = await userClient.rpc(
      "current_user_requires_mfa",
    );
    if (requiresMfa) {
      const { data: claims } = await userClient.auth.getClaims();
      if (claims?.claims.aal !== "aal2")
        return { ok: false, code: "mfa_required" };
    }
    const { data: allowed, error: permError } = await userClient.rpc(
      "has_permission",
      { permission_key: "driver.manage", target_branch_id: input.branchId },
    );
    if (permError) return { ok: false, code: "service_error" };
    if (!allowed) return { ok: false, code: "forbidden" };

    const { data: companyId } = await userClient.rpc("current_company_id");
    if (!companyId) return { ok: false, code: "service_error" };

    const loginIdentifier = deriveLoginIdentifier(
      secret,
      companyId,
      employeeNumber,
    );
    const pin = generatePin(config.pin);

    const { data: created, error: createError } =
      await admin.auth.admin.createUser({
        email: loginIdentifier,
        password: pin,
        email_confirm: true,
      });
    if (createError || !created.user) {
      // the login identifier is derived from the employee number, so a clash is a duplicate driver
      return createError?.code === "email_exists"
        ? { ok: false, code: "employee_number_taken" }
        : { ok: false, code: "service_error" };
    }
    const userId = created.user.id;

    const { data: driverId, error: dbError } = await admin.rpc(
      "admin_create_driver",
      {
        p_actor: caller.id,
        p_user_id: userId,
        p_branch_id: input.branchId,
        p_employee_number: employeeNumber,
        p_login_identifier: loginIdentifier,
        p_display_name: displayName,
        p_phone: input.phone?.trim() || undefined,
      },
    );
    if (dbError || !driverId) {
      // Compensate: the database transaction rolled back, so only the Auth user exists. Remove it.
      const { error: deleteError } = await admin.auth.admin.deleteUser(userId);
      if (deleteError)
        return { ok: false, code: "rollback_failed", orphanUserId: userId };
      switch (dbError?.code) {
        case "42501":
          return { ok: false, code: "forbidden" };
        case "23505":
          return { ok: false, code: "employee_number_taken" };
        case "23514":
        case "22023":
          return { ok: false, code: "invalid_input" };
        default:
          return { ok: false, code: "service_error" };
      }
    }
    return { ok: true, driverId, userId, pin };
  }
}
