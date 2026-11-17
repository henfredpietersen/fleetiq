"use server";
// Server actions for staff account administration. Each re-checks the session (MFA stage included, DEC-34),
// validates with zod, and then either runs as the signed-in user (role assignment: RLS decides) or calls a
// reviewed server-only admin function that authorises the caller itself (create / reset). Nothing here holds
// the service-role key; the one-time password is returned to the issuer in the action result and nowhere else.
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { loadAuthConfig } from "../domain/auth-config";
import {
  describeStaffPasswordViolations,
  generateStaffPassword,
} from "../domain/staff-password-policy";
import type { ActionState } from "../ui/action-state";
import { createStaffAccount, resetStaffPassword } from "./admin-accounts";
import { assignRole, revokeRole } from "./role-assignments";
import { requireSession } from "./session";

const uuid = z.uuid("Invalid identifier");
const text = (form: FormData, key: string) => {
  const v = form.get(key);
  return typeof v === "string" ? v.trim() : "";
};

const createSchema = z.object({
  email: z.email("Enter a valid email address.").max(254),
  displayName: z
    .string()
    .min(1, "Enter the person's name.")
    .max(200, "The name is too long."),
});

const FAILURES: Record<string, string> = {
  unauthenticated: "Your session has expired. Please sign in again.",
  forbidden: "You do not have permission to do this.",
  mfa_required: "Complete two-step verification before doing this.",
  invalid_email: "Enter a valid, deliverable email address.",
  email_taken: "A user with this email address already exists.",
  not_found: "That user was not found.",
  self_reset: "You cannot reset your own password here. Use Change password.",
  self_change: "You cannot change your own roles.",
  invalid_input: "Some of the details are not valid for this company.",
  rollback_failed:
    "The account could not be completed and a leftover sign-in could not be removed. Contact an administrator.",
};
const GENERIC = "Something went wrong on our side. Please try again.";

function failure(code: string, details?: string[]): ActionState {
  return { status: "error", message: FAILURES[code] ?? GENERIC, details };
}

export async function createStaffUserAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  await requireSession("full");
  const parsed = createSchema.safeParse({
    email: text(form, "email"),
    displayName: text(form, "displayName"),
  });
  if (!parsed.success)
    return {
      status: "error",
      message: "Check the details and try again.",
      details: parsed.error.issues.map((i) => i.message),
    };
  const r = await createStaffAccount(parsed.data);
  if (!r.ok) return failure(r.code);
  revalidatePath("/admin/users");
  return {
    status: "success",
    message:
      "Staff account created. They must choose their own password at first sign-in, and set up two-step verification if their roles require it.",
    revealed: r.temporaryPassword
      ? { label: "Temporary password", value: r.temporaryPassword }
      : undefined,
  };
}

export async function resetStaffPasswordAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  await requireSession("full");
  const id = uuid.safeParse(text(form, "userId"));
  if (!id.success) return failure("not_found");
  const rules = loadAuthConfig().staffPassword;
  const newPassword = generateStaffPassword(rules);
  const r = await resetStaffPassword({
    targetUserId: id.data,
    newPassword,
  });
  if (!r.ok) {
    return failure(
      r.code,
      r.code === "weak_password"
        ? describeStaffPasswordViolations(r.violations, rules)
        : undefined,
    );
  }
  return {
    status: "success",
    message: "Password reset. They must choose a new one at next sign-in.",
    revealed: { label: "Temporary password", value: newPassword },
  };
}

const assignSchema = z.object({
  userId: uuid,
  roleId: uuid,
  branchId: uuid.nullable(),
});

export async function assignRoleAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  await requireSession("full");
  const branch = text(form, "branchId");
  const parsed = assignSchema.safeParse({
    userId: text(form, "userId"),
    roleId: text(form, "roleId"),
    branchId: branch === "" ? null : branch,
  });
  if (!parsed.success)
    return { status: "error", message: "Choose a role and a scope." };
  const r = await assignRole(await createSupabaseServerClient(), parsed.data);
  if (!r.ok) return failure(r.code);
  revalidatePath(`/admin/users/${parsed.data.userId}`);
  revalidatePath("/admin/users");
  return { status: "success", message: "Role assigned." };
}

export async function revokeRoleAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  await requireSession("full");
  const grant = uuid.safeParse(text(form, "grantId"));
  const user = uuid.safeParse(text(form, "userId"));
  if (!grant.success || !user.success) return failure("not_found");
  const r = await revokeRole(await createSupabaseServerClient(), {
    grantId: grant.data,
  });
  if (!r.ok) return failure(r.code);
  revalidatePath(`/admin/users/${user.data}`);
  revalidatePath("/admin/users");
  return { status: "success", message: "Role ended." };
}
