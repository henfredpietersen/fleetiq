"use server";
// Server actions = the only entry points the drivers screens use. Each re-checks the session (including the MFA
// stage, DEC-34), validates with zod, and then runs as the signed-in user (RLS and the SQL functions authorise) or
// calls a reviewed server-only admin function (create driver, reset PIN) that authorises the caller itself.
// This file never holds the service-role key.
import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { issueDriverPin } from "@/modules/identity-access/server/admin-pin";
import { createDriverAccount } from "@/modules/identity-access/server/admin-accounts";
import { requireSession } from "@/modules/identity-access/server/session";
import type { ActionState } from "@/modules/identity-access/ui/action-state";
import {
  createDriverSchema,
  formToObject,
  issueMessages,
  uuidField,
} from "../domain/driver-schema";
import * as service from "./driver-service";

async function context() {
  const ctx = await requireSession("full");
  return { ctx, db: await createSupabaseServerClient() };
}

const fail = (r: { message: string; details?: string[] }): ActionState => ({
  status: "error",
  message: r.message,
  details: r.details,
});

const CREATE_FAILURES: Record<string, string> = {
  unauthenticated: "Your session has expired. Please sign in again.",
  forbidden:
    "You do not have permission to create drivers in that branch. This needs driver.manage for the branch.",
  mfa_required: "Complete two-step verification before creating drivers.",
  invalid_employee_number:
    "Employee number: letters, digits and hyphens only, up to 20 characters.",
  invalid_input: "Some of the details are not valid.",
  employee_number_taken: "A driver with this employee number already exists.",
  rollback_failed:
    "The driver could not be created and a leftover sign-in could not be removed. Contact an administrator.",
};
const GENERIC = "Something went wrong on our side. Please try again.";

export async function createDriverAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  await requireSession("full");
  const parsed = createDriverSchema.safeParse(formToObject(form));
  if (!parsed.success)
    return {
      status: "error",
      message: "Check the details and try again.",
      details: issueMessages(parsed.error),
    };
  const r = await createDriverAccount({
    branchId: parsed.data.branchId,
    employeeNumber: parsed.data.employeeNumber,
    displayName: parsed.data.displayName,
    phone: parsed.data.phone,
  });
  if (!r.ok)
    return { status: "error", message: CREATE_FAILURES[r.code] ?? GENERIC };
  revalidatePath("/drivers");
  return {
    status: "success",
    message: `Driver ${parsed.data.employeeNumber} created. They must change this PIN the first time they sign in.`,
    revealed: { label: "Temporary PIN", value: r.pin },
  };
}

export async function updateDriverAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const { db } = await context();
  const r = await service.updateDriver(db, formToObject(form));
  if (!r.ok) return fail(r);
  revalidatePath("/drivers");
  revalidatePath(`/drivers/${r.driverId}`);
  return { status: "success", message: "Driver details saved." };
}

export async function setDriverStatusAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const { db } = await context();
  const r = await service.setDriverStatus(db, formToObject(form));
  if (!r.ok) return fail(r);
  revalidatePath("/drivers");
  revalidatePath(`/drivers/${r.driverId}`);
  return {
    status: "success",
    message:
      r.status === "inactive"
        ? "Driver deactivated. They can no longer sign in; their history is kept."
        : "Driver reactivated.",
  };
}

export async function recordLicenceAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const { db } = await context();
  const raw = formToObject(form);
  const r = await service.recordLicence(db, {
    ...raw,
    // the form carries its own id so a retry is idempotent; fall back to a fresh one
    clientSubmissionId: raw.clientSubmissionId ?? randomUUID(),
  });
  if (!r.ok) return fail(r);
  revalidatePath(`/drivers/${r.driverId}`);
  revalidatePath("/drivers");
  return {
    status: "success",
    message:
      "Licence recorded. A different administrator must verify it before it counts.",
  };
}

export async function verifyLicenceAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const { db } = await context();
  const r = await service.verifyLicence(db, formToObject(form));
  if (!r.ok) return fail(r);
  revalidatePath(`/drivers/${r.driverId}`);
  revalidatePath("/drivers");
  return {
    status: "success",
    message:
      r.decision === "verified"
        ? "Licence record verified."
        : "Licence record rejected.",
  };
}

const RESET_FAILURES: Record<string, string> = {
  unauthenticated: "Your session has expired. Please sign in again.",
  mfa_required: "Complete two-step verification before resetting a PIN.",
  forbidden: "You do not have permission to reset this driver's PIN.",
  not_found: "That driver was not found.",
  self_reset: "You cannot reset your own PIN.",
};

/** Reset a driver's PIN (reviewed admin function, 1B). The new PIN is shown once to the issuer and never stored. */
export async function resetDriverPinAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const { db } = await context();
  const id = uuidField.safeParse(formToObject(form).driverId);
  if (!id.success)
    return { status: "error", message: RESET_FAILURES.not_found };
  const { data: driver } = await db
    .from("drivers")
    .select("profile_id")
    .eq("id", id.data)
    .maybeSingle();
  if (!driver) return { status: "error", message: RESET_FAILURES.not_found };
  const r = await issueDriverPin({
    targetProfileId: driver.profile_id,
    mode: "reset",
  });
  if (!r.ok)
    return { status: "error", message: RESET_FAILURES[r.code] ?? GENERIC };
  revalidatePath(`/drivers/${id.data}`);
  return {
    status: "success",
    message: "PIN reset. The driver's sign-in lock (if any) is cleared.",
    revealed: { label: "Temporary PIN", value: r.pin },
  };
}
