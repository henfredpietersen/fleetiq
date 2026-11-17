import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { isInternalIdentifier } from "../domain/identifiers";
import { nextAuthStep, type NextStep } from "../domain/next-step";

export type StaffSignInResult =
  | { ok: true; next: NextStep }
  | { ok: false; code: "invalid_credentials" | "service_error" };

/**
 * Office/management sign-in: email + password through Supabase Auth (DEC-34). Rate limiting is
 * Supabase Auth's own (config.toml [auth.rate_limit]); the driver lockout table is not used here.
 * A driver's internal identifier is refused up front and a non-staff profile is signed straight out,
 * so this form can never be used to bypass the driver PIN limiter.
 */
export async function staffSignIn(
  supabase: SupabaseClient<Database>,
  input: { email: string; password: string },
): Promise<StaffSignInResult> {
  const email = input.email.trim().toLowerCase();
  if (!email || !input.password || isInternalIdentifier(email))
    return { ok: false, code: "invalid_credentials" };

  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password: input.password,
  });
  if (error || !data.user) {
    return {
      ok: false,
      code:
        error && error.status !== undefined && error.status >= 500
          ? "service_error"
          : "invalid_credentials",
    };
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("user_type, status, must_change_pin")
    .eq("id", data.user.id)
    .maybeSingle();
  if (
    !profile ||
    profile.user_type !== "staff" ||
    profile.status !== "active"
  ) {
    await supabase.auth.signOut();
    return { ok: false, code: "invalid_credentials" };
  }

  const { data: requiresMfa } = await supabase.rpc("current_user_requires_mfa");
  const { data: claims } = await supabase.auth.getClaims();
  return {
    ok: true,
    next: nextAuthStep({
      mustChangePin: profile.must_change_pin,
      requiresMfa: requiresMfa === true,
      aal: claims?.claims.aal === "aal2" ? "aal2" : "aal1",
    }),
  };
}
