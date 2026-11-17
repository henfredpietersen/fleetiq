import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import type { AuthConfig } from "../domain/auth-config";
import { isInternalIdentifier } from "../domain/identifiers";
import {
  validateStaffPassword,
  type StaffPasswordViolation,
} from "../domain/staff-password-policy";

/**
 * The ONLY place a staff password is set (carry-over C3 / DEC-34). Create, reset and change all validate the
 * password against the configured staff policy (minimum 12 characters by default) BEFORE anything reaches
 * Supabase Auth, whose own minimum (6) exists only because driver PINs share it and is never relied on here.
 * A unit test fails if any other module calls Auth's password-setting APIs (staff-accounts.architecture.test.ts).
 *
 * Backstop: Auth itself still accepts a 6-character password (driver PINs share it), so the database refuses any
 * staff password-hash change that was not authorised by this class (trigger staff_password_guard, migration 017).
 * A browser calling Auth's updateUser directly, or a recovery link, therefore fails for staff.
 */

export type StaffPasswordFailure =
  | { ok: false; code: "weak_password"; violations: StaffPasswordViolation[] }
  | { ok: false; code: "unauthenticated" | "forbidden" | "mfa_required" }
  | { ok: false; code: "not_found" | "self_reset" | "same_password" }
  | { ok: false; code: "invalid_email" | "email_taken" | "service_error" };

export type CreateStaffUserResult =
  { ok: true; userId: string } | StaffPasswordFailure;
export type SetStaffPasswordResult = { ok: true } | StaffPasswordFailure;

export type StaffAccountsDeps = {
  /** Service-role client: reviewed admin function only, never reachable from the browser. */
  admin: SupabaseClient<Database>;
  /** The caller's own session client (RLS applies; has_permission() is evaluated as the caller). */
  userClient: SupabaseClient<Database>;
  config: Pick<AuthConfig, "staffPassword">;
  now?: () => Date;
};

const MANAGE_USERS = "users.roles.manage";

export class StaffAccounts {
  constructor(private readonly d: StaffAccountsDeps) {}

  private weak(password: string): StaffPasswordFailure | null {
    const check = validateStaffPassword(password, this.d.config.staffPassword);
    return check.ok
      ? null
      : { ok: false, code: "weak_password", violations: check.violations };
  }

  /**
   * Resolves the caller and requires users.roles.manage (company-wide) through the single has_permission()
   * helper, plus AAL2 when the caller's roles require MFA (DEC-34; has_permission also demands it).
   */
  private async authoriseManager(): Promise<
    { ok: true; callerId: string } | StaffPasswordFailure
  > {
    const { userClient } = this.d;
    const { data } = await userClient.auth.getUser();
    const caller = data.user;
    if (!caller) return { ok: false, code: "unauthenticated" };

    const { data: requiresMfa } = await userClient.rpc(
      "current_user_requires_mfa",
    );
    if (requiresMfa) {
      const { data: claims } = await userClient.auth.getClaims();
      if (claims?.claims.aal !== "aal2")
        return { ok: false, code: "mfa_required" };
    }
    const { data: allowed, error } = await userClient.rpc("has_permission", {
      permission_key: MANAGE_USERS,
      target_branch_id: null as unknown as string, // null = company-wide (generated type is non-nullable)
    });
    if (error) return { ok: false, code: "service_error" };
    if (!allowed) return { ok: false, code: "forbidden" };
    return { ok: true, callerId: caller.id };
  }

  /** CREATE: a manager creates a staff login. Profile + role rows are the caller's job (account management). */
  async createStaffUser(input: {
    email: string;
    password: string;
  }): Promise<CreateStaffUserResult> {
    const weak = this.weak(input.password);
    if (weak) return weak;
    const email = input.email.trim().toLowerCase();
    if (!email.includes("@") || isInternalIdentifier(email))
      return { ok: false, code: "invalid_email" };

    const auth = await this.authoriseManager();
    if (!auth.ok) return auth;

    const { data, error } = await this.d.admin.auth.admin.createUser({
      email,
      password: input.password,
      email_confirm: true,
    });
    if (error || !data.user) {
      if (error?.code === "email_exists")
        return { ok: false, code: "email_taken" };
      if (error?.code === "weak_password")
        return { ok: false, code: "weak_password", violations: ["too_short"] };
      return { ok: false, code: "service_error" };
    }
    return { ok: true, userId: data.user.id };
  }

  /** RESET: a manager sets another staff member's password. Nobody resets their own (DEC-24). */
  async resetStaffPassword(input: {
    targetUserId: string;
    newPassword: string;
  }): Promise<SetStaffPasswordResult> {
    const weak = this.weak(input.newPassword);
    if (weak) return weak;

    const auth = await this.authoriseManager();
    if (!auth.ok) return auth;
    if (auth.callerId === input.targetUserId)
      return { ok: false, code: "self_reset" };

    // Reviewed service-role read: the caller's RLS cannot see every profile, so company and type are
    // resolved here, then compared with the caller's own company.
    const { data: target } = await this.d.admin
      .from("profiles")
      .select("id, company_id, user_type")
      .eq("id", input.targetUserId)
      .maybeSingle();
    const { data: callerCompany } =
      await this.d.userClient.rpc("current_company_id");
    if (
      !target ||
      target.user_type !== "staff" ||
      !callerCompany ||
      target.company_id !== callerCompany
    )
      return { ok: false, code: "not_found" };

    // The database refuses any staff password-hash change without this single-use authorisation (migration 017),
    // so it is recorded only now: after the policy check, the permission checks and the target checks.
    const { error: authError } = await this.d.admin.rpc(
      "authorise_staff_password_change",
      { p_user: target.id, p_actor: auth.callerId },
    );
    if (authError) return { ok: false, code: "service_error" };

    const { error } = await this.d.admin.auth.admin.updateUserById(target.id, {
      password: input.newPassword,
    });
    return error ? { ok: false, code: "service_error" } : { ok: true };
  }

  /** CHANGE: a signed-in staff member changes their own password. */
  async changeOwnPassword(input: {
    newPassword: string;
  }): Promise<SetStaffPasswordResult> {
    const weak = this.weak(input.newPassword);
    if (weak) return weak;

    const { userClient } = this.d;
    const { data } = await userClient.auth.getUser();
    const user = data.user;
    if (!user) return { ok: false, code: "unauthenticated" };
    const { data: own } = await userClient
      .from("profiles")
      .select("user_type")
      .eq("id", user.id)
      .maybeSingle();
    // Drivers change a PIN, not a password (their own rules, supabase-driver-auth.ts).
    if (own?.user_type !== "staff") return { ok: false, code: "forbidden" };

    const { error: authError } = await this.d.admin.rpc(
      "authorise_staff_password_change",
      { p_user: user.id, p_actor: user.id },
    );
    if (authError) return { ok: false, code: "service_error" };

    const { error } = await userClient.auth.updateUser({
      password: input.newPassword,
    });
    if (error) {
      if (error.code === "same_password")
        return { ok: false, code: "same_password" };
      if (error.code === "weak_password")
        return { ok: false, code: "weak_password", violations: ["too_short"] };
      return { ok: false, code: "service_error" };
    }
    return { ok: true };
  }
}
