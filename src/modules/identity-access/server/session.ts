import "server-only";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { nextAuthStep, type NextStep } from "../domain/next-step";

export type SessionContext = {
  userId: string;
  email: string | null;
  profile: {
    displayName: string;
    userType: "driver" | "staff";
    status: string;
    mustChangePin: boolean;
    companyId: string;
  };
  aal: "aal1" | "aal2";
  /** DEC-34: holds an administrator role or an approval permission. */
  requiresMfa: boolean;
};

/** Authenticated user + own profile + assurance level, validated against Supabase Auth. Null when signed out. */
export async function getSessionContext(): Promise<SessionContext | null> {
  await connection(); // request-time only: never prerender session reads
  const supabase = await createSupabaseServerClient();
  const { data: userData, error } = await supabase.auth.getUser();
  if (error || !userData.user) return null;
  const user = userData.user;

  const { data: profile } = await supabase
    .from("profiles")
    .select("display_name, user_type, status, must_change_pin, company_id")
    .eq("id", user.id)
    .maybeSingle();
  if (
    !profile ||
    (profile.user_type !== "driver" && profile.user_type !== "staff")
  )
    return null;

  const { data: claims } = await supabase.auth.getClaims();
  const { data: requiresMfa } = await supabase.rpc("current_user_requires_mfa");

  return {
    userId: user.id,
    email: user.email ?? null,
    profile: {
      displayName: profile.display_name,
      userType: profile.user_type,
      status: profile.status,
      mustChangePin: profile.must_change_pin,
      companyId: profile.company_id,
    },
    aal: claims?.claims.aal === "aal2" ? "aal2" : "aal1",
    requiresMfa: requiresMfa === true,
  };
}

export function stepFor(ctx: SessionContext): NextStep {
  return nextAuthStep({
    mustChangePin: ctx.profile.mustChangePin,
    requiresMfa: ctx.requiresMfa,
    aal: ctx.aal,
  });
}

export type RequiredStage = "change-pin" | "mfa" | "full";

/**
 * Server-side route guard. A session is only "full" once any forced PIN change is done and — for
 * administrators and approvers — MFA has been satisfied (AAL2). The UI redirect is a convenience:
 * the same rules are enforced in the database by has_permission()/RLS.
 */
export async function requireSession(
  stage: RequiredStage = "full",
): Promise<SessionContext> {
  const ctx = await getSessionContext();
  if (!ctx) redirect("/sign-in");
  if (ctx.profile.status !== "active") redirect("/sign-in?reason=inactive");
  const step = stepFor(ctx);
  const wanted: NextStep =
    stage === "change-pin" ? "/change-pin" : stage === "mfa" ? "/mfa" : "/home";
  if (step !== wanted) redirect(step);
  return ctx;
}

/** For route handlers / server actions that serve admin or approval operations. */
export function isMfaSatisfied(
  ctx: Pick<SessionContext, "requiresMfa" | "aal">,
): boolean {
  return !ctx.requiresMfa || ctx.aal === "aal2";
}
