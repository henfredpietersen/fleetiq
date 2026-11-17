import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import type { AuthConfig } from "../domain/auth-config";
import type {
  ChangePinResult,
  DriverAuth,
  DriverSignInInput,
  DriverSignInResult,
  IssuePinInput,
  IssuePinResult,
} from "../domain/driver-auth";
import {
  deriveLoginIdentifier,
  hashEmployeeNumber,
  hashIp,
  normalizeEmployeeNumber,
} from "../domain/identifiers";
import {
  evaluateLockout,
  lockoutExpiry,
  reachesAccountLockout,
} from "../domain/lockout";
import { generatePin, validatePin } from "../domain/pin-rules";

type Client = SupabaseClient<Database>;

export type DriverAuthDeps = {
  /** Service-role client: ONLY for the attempt log, lockout, and the PIN admin path. */
  admin: Client;
  /** Client bound to the current request's session cookies (anon key). */
  userClient: Client;
  config: AuthConfig;
  /** AUTH_SERVER_SECRET */
  secret: string;
  /** The single company this deployment serves (FLEETIQ_COMPANY_ID). */
  companyId: string;
  now?: () => Date;
};

/**
 * AD-08 (Proposed) implementation of DriverAuth: employee number -> internal login identifier
 * (keyed HMAC) -> Supabase Auth password sign-in with the PIN as the password.
 *
 * Non-disclosure: every failure path runs the same steps (count, Auth call, record) and returns the
 * same result, whether or not the employee number exists. Lockout is keyed by the HASHED number.
 */
export class SupabaseDriverAuth implements DriverAuth {
  constructor(private readonly d: DriverAuthDeps) {}

  private now(): Date {
    return (this.d.now ?? (() => new Date()))();
  }

  async signIn(input: DriverSignInInput): Promise<DriverSignInResult> {
    const { admin, userClient, config, secret, companyId } = this.d;
    try {
      const emp = normalizeEmployeeNumber(input.employeeNumber);
      // Malformed input is hashed and processed like any other number: no early, distinguishable exit.
      const keyed = emp ?? `invalid:${input.employeeNumber.slice(0, 64)}`;
      const empHash = hashEmployeeNumber(secret, companyId, keyed);
      const ipHash = hashIp(secret, input.ip);
      const identifier = deriveLoginIdentifier(secret, companyId, keyed);

      const { data: profile } = await admin
        .from("profiles")
        .select("id, company_id, user_type, status")
        .eq("login_identifier", identifier)
        .maybeSingle();

      const { data: counts, error: countsError } = await admin
        .rpc("auth_login_counts", {
          p_emp_hash: empHash,
          p_ip_hash: ipHash,
          p_window: `${config.lockout.windowMinutes} minutes`,
          p_profile_id: profile?.id,
        })
        .single();
      if (countsError || !counts) return { ok: false, code: "service_error" };

      const decision = evaluateLockout(
        {
          accountFailures: counts.account_failures,
          accountLastFailureAt: counts.account_last_failure,
          ipFailures: counts.ip_failures,
          ipLastFailureAt: counts.ip_last_failure,
        },
        this.now(),
        config.lockout,
      );
      if (!decision.allowed)
        return {
          ok: false,
          code: "locked",
          retryAfterSeconds: decision.retryAfterSeconds,
        };

      const { data: auth, error: authError } =
        await userClient.auth.signInWithPassword({
          email: identifier,
          password: input.pin,
        });

      const signedInUser = authError ? null : auth.user;
      if (
        !signedInUser ||
        !profile ||
        profile.id !== signedInUser.id ||
        profile.user_type !== "driver" ||
        profile.status !== "active"
      ) {
        // Includes "no such number": same recording, same lockout rule, same result as a wrong PIN.
        if (signedInUser) await userClient.auth.signOut();
        await admin.rpc("auth_login_record", {
          p_company: companyId,
          p_emp_hash: empHash,
          p_profile: (profile?.id ?? null) as unknown as string,
          p_ip_hash: ipHash,
          p_succeeded: false,
        });
        if (reachesAccountLockout(counts.account_failures, config.lockout)) {
          const until = lockoutExpiry(this.now(), config.lockout);
          if (profile)
            await admin.rpc("auth_lock_profile", {
              p_profile: profile.id,
              p_until: until.toISOString(),
            });
          return {
            ok: false,
            code: "locked",
            retryAfterSeconds: config.lockout.accountLockoutMinutes * 60,
          };
        }
        return { ok: false, code: "invalid_credentials" };
      }

      await admin.rpc("auth_login_record", {
        p_company: companyId,
        p_emp_hash: empHash,
        p_profile: profile.id,
        p_ip_hash: ipHash,
        p_succeeded: true,
      });
      // Read the flag from the user's own row (RLS: own profile is always readable).
      const { data: own } = await userClient
        .from("profiles")
        .select("must_change_pin")
        .eq("id", profile.id)
        .maybeSingle();
      return { ok: true, next: own?.must_change_pin ? "/change-pin" : "/home" };
    } catch {
      return { ok: false, code: "service_error" };
    }
  }

  async changePin(input: { newPin: string }): Promise<ChangePinResult> {
    const { admin, userClient, config } = this.d;
    const check = validatePin(input.newPin, config.pin);
    if (!check.ok)
      return { ok: false, code: "weak_pin", violations: check.violations };
    const { data: userData } = await userClient.auth.getUser();
    const user = userData.user;
    if (!user) return { ok: false, code: "service_error" };
    const { data: own } = await userClient
      .from("profiles")
      .select("user_type")
      .eq("id", user.id)
      .maybeSingle();
    if (own?.user_type !== "driver") return { ok: false, code: "not_driver" };

    const { error } = await userClient.auth.updateUser({
      password: input.newPin,
    });
    if (error) {
      if (error.code === "same_password")
        return { ok: false, code: "same_pin" };
      if (error.code === "weak_password")
        return { ok: false, code: "weak_pin", violations: ["wrong_length"] };
      return { ok: false, code: "service_error" };
    }
    // Only now (after Auth accepted the new PIN) is the forced-change flag cleared, by the server.
    const { error: flagError } = await admin.rpc("auth_complete_pin_change", {
      p_profile: user.id,
    });
    return flagError ? { ok: false, code: "service_error" } : { ok: true };
  }

  async issuePin(input: IssuePinInput): Promise<IssuePinResult> {
    const { admin, userClient, config } = this.d;
    const { data: userData } = await userClient.auth.getUser();
    const caller = userData.user;
    if (!caller) return { ok: false, code: "unauthenticated" };

    // DEC-24: nobody issues or resets their own PIN. (The database function refuses it as well.)
    if (caller.id === input.targetProfileId)
      return { ok: false, code: "self_reset" };

    // DEC-34: approvers/administrators must be at AAL2. has_permission() below also enforces it.
    const { data: requiresMfa } = await userClient.rpc(
      "current_user_requires_mfa",
    );
    if (requiresMfa) {
      const { data: claims } = await userClient.auth.getClaims();
      if (claims?.claims.aal !== "aal2")
        return { ok: false, code: "mfa_required" };
    }

    // Reviewed service-role read: the caller's RLS cannot see other profiles, so scope is resolved here
    // and then checked with the caller's own session through the single has_permission() helper.
    const { data: target } = await admin
      .from("profiles")
      .select("id, company_id, user_type")
      .eq("id", input.targetProfileId)
      .maybeSingle();
    const { data: callerCompany } = await userClient.rpc("current_company_id");
    if (
      !target ||
      target.user_type !== "driver" ||
      !callerCompany ||
      target.company_id !== callerCompany
    ) {
      return { ok: false, code: "not_found" };
    }

    const nowIso = this.now().toISOString();
    const { data: grants } = await admin
      .from("user_roles")
      .select("branch_id, effective_from, effective_to")
      .eq("user_id", target.id)
      .lte("effective_from", nowIso);
    const active = (grants ?? []).filter(
      (g) => g.effective_to === null || g.effective_to > nowIso,
    );
    if (active.length === 0) return { ok: false, code: "not_found" };

    for (const g of active) {
      const { data: allowed, error } = await userClient.rpc("has_permission", {
        permission_key: "driver.manage",
        target_branch_id: g.branch_id as string, // null = company-wide target (generated type is non-nullable)
      });
      if (error) return { ok: false, code: "service_error" };
      if (!allowed) return { ok: false, code: "forbidden" };
    }

    const pin = generatePin(config.pin);
    // Flags first: if the Auth update then fails, the old PIN still works but must be changed.
    const { error: flagError } = await admin.rpc("auth_issue_pin_flags", {
      p_target: target.id,
      p_actor: caller.id,
      p_mode: input.mode,
    });
    if (flagError)
      return {
        ok: false,
        code: flagError.code === "42501" ? "forbidden" : "service_error",
      };
    const { error: pwError } = await admin.auth.admin.updateUserById(
      target.id,
      { password: pin },
    );
    if (pwError) return { ok: false, code: "service_error" };
    return { ok: true, pin };
  }
}
