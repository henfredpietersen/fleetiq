import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";

/**
 * Assign / revoke roles with branch scope (AD-05: user_roles is the only branch-scope source).
 * Runs entirely as the SIGNED-IN USER: no service-role key. The authority is the existing user_roles RLS
 * policies (migrations 004/008/013) and triggers — users.roles.manage, same company, granted_by = the caller,
 * never your own roles (DEC-24), a grant can only be ended or cancelled, never extended. This module adds no
 * second copy of those rules; it only turns database refusals into stable result codes. The user_roles audit
 * trigger records every grant and end-date.
 */
export type RoleAssignmentResult =
  | { ok: true }
  | {
      ok: false;
      code:
        | "unauthenticated"
        | "forbidden"
        | "self_change"
        | "not_found"
        | "invalid_input"
        | "service_error";
    };

type Db = SupabaseClient<Database>;

function map(error: {
  code?: string;
  message?: string;
}): RoleAssignmentResult & { ok: false } {
  switch (error.code) {
    case "42501": // RLS: not users.roles.manage, other company, or granted_by / self rules
      return { ok: false, code: "forbidden" };
    case "23514": // user_roles CHECKs / validate trigger (role not available to this company, dates)
    case "23503": // foreign key: unknown user, role or branch in this company
      return { ok: false, code: "invalid_input" };
    default:
      return { ok: false, code: "service_error" };
  }
}

export async function assignRole(
  db: Db,
  input: { userId: string; roleId: string; branchId: string | null },
): Promise<RoleAssignmentResult> {
  const { data: u } = await db.auth.getUser();
  const caller = u.user;
  if (!caller) return { ok: false, code: "unauthenticated" };
  // Friendly early answer only; the policy (user_id <> auth.uid()) is the real rule.
  if (input.userId === caller.id) return { ok: false, code: "self_change" };

  const { data: companyId } = await db.rpc("current_company_id");
  if (!companyId) return { ok: false, code: "forbidden" };

  const { error } = await db.from("user_roles").insert({
    user_id: input.userId,
    role_id: input.roleId,
    company_id: companyId,
    branch_id: input.branchId,
    granted_by: caller.id,
  });
  return error ? map(error) : { ok: true };
}

/**
 * End a grant now (or cancel one that has not started yet: effective_to = effective_from). Grants are history —
 * never deleted. The update policy only lets this succeed for another user's grant.
 */
export async function revokeRole(
  db: Db,
  input: { grantId: string },
): Promise<RoleAssignmentResult> {
  const { data: u } = await db.auth.getUser();
  if (!u.user) return { ok: false, code: "unauthenticated" };

  const { data: grant, error: readError } = await db
    .from("user_roles")
    .select("id, user_id, effective_from, effective_to")
    .eq("id", input.grantId)
    .maybeSingle();
  if (readError) return map(readError);
  if (!grant) return { ok: false, code: "not_found" };
  if (grant.user_id === u.user.id) return { ok: false, code: "self_change" };

  // The database only accepts an end time at or before ITS now(), so end one second ago on this clock, but never
  // before the grant started (a grant that has not started, or started this second, is collapsed to zero length).
  const from = new Date(grant.effective_from);
  const end = new Date(Math.max(from.getTime(), Date.now() - 1000));
  const { data: updated, error } = await db
    .from("user_roles")
    .update({ effective_to: end.toISOString() })
    .eq("id", grant.id)
    .select("id");
  if (error) return map(error);
  // RLS hides rows it refuses instead of raising: zero rows updated means "not allowed" (or already ended)
  return updated && updated.length > 0
    ? { ok: true }
    : { ok: false, code: "forbidden" };
}
