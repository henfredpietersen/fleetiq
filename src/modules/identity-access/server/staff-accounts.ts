import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import type { AuthConfig } from "../domain/auth-config";
import { isInternalIdentifier } from "../domain/identifiers";
import {
  generateStaffPassword,
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
  | { ok: false; code: "invalid_email" | "email_taken" | "service_error" }
  // The profile step failed AND the Auth user could not be removed again: an operator must delete it.
  | { ok: false; code: "rollback_failed"; orphanUserId: string };

export type CreateStaffUserResult =
  // temporaryPassword is returned exactly once, only when the server generated it; never stored or logged.
  | { ok: true; userId: string; temporaryPassword?: string }
  | StaffPasswordFailure;
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

  /**
   * CREATE: a manager creates a staff account — Auth user, then profile, in one flow (DEC-34).
   * The password is temporary: the profile is created with the forced-change flag, so the person must choose
   * their own before any access, and then enrol MFA at /mfa if their roles require it. If the profile step fails
   * the Auth user is deleted again, so no orphan account is left behind.
   */
  async createStaffUser(input: {
    email: string;
    displayName: string;
    /** Omit to have the server generate one (returned once). Supplied passwords face the same policy. */
    password?: string;
  }): Promise<CreateStaffUserResult> {
    const generated = input.password === undefined;
    const password =
      input.password ?? generateStaffPassword(this.d.config.staffPassword);
    const weak = this.weak(password);
    if (weak) return weak;
    const email = input.email.trim().toLowerCase();
    const displayName = input.displayName.trim();
    if (!email.includes("@") || isInternalIdentifier(email) || !displayName)
      return { ok: false, code: "invalid_email" };

    const auth = await this.authoriseManager();
    if (!auth.ok) return auth;

    const { data, error } = await this.d.admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (error || !data.user) {
      if (error?.code === "email_exists")
        return { ok: false, code: "email_taken" };
      if (error?.code === "weak_password")
        return { ok: false, code: "weak_password", violations: ["too_short"] };
      return { ok: false, code: "service_error" };
    }
    const userId = data.user.id;

    const { error: profileError } = await this.d.admin.rpc(
      "admin_create_staff",
      {
        p_actor: auth.callerId,
        p_user_id: userId,
        p_email: email,
        p_display_name: displayName,
      },
    );
    if (profileError) {
      const { error: deleteError } =
        await this.d.admin.auth.admin.deleteUser(userId);
      if (deleteError)
        return { ok: false, code: "rollback_failed", orphanUserId: userId };
      if (profileError.code === "42501")
        return { ok: false, code: "forbidden" };
      if (profileError.code === "23505")
        return { ok: false, code: "email_taken" };
      return { ok: false, code: "service_error" };
    }
    return generated
      ? { ok: true, userId, temporaryPassword: password }
      : { ok: true, userId };
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

    // The reset password is temporary: the person must choose their own at next sign-in (audited, DEC-24).
    const { error: flagError } = await this.d.admin.rpc(
      "auth_issue_staff_password_flags",
      { p_target: target.id, p_actor: auth.callerId },
    );
    if (flagError) return { ok: false, code: "service_error" };

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
    // Only now (after Auth accepted the new password) is the forced-change flag cleared, by the server.
    const { error: flagError } = await this.d.admin.rpc(
      "auth_complete_password_change",
      { p_profile: user.id },
    );
    return flagError ? { ok: false, code: "service_error" } : { ok: true };
  }
}
