"use server";
// Server actions = the only entry points the UI uses. Each re-checks the session (including the MFA stage,
// DEC-34) and then runs as the signed-in user, so RLS and the SQL functions authorise. Inputs are validated with
// zod in service-service. The service-role key is never used here.
import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireSession } from "@/modules/identity-access/server/session";
import type { ActionState } from "@/modules/fleet-vehicles/domain/action-state";
import { formToObject } from "../domain/service-schema";
import * as service from "./service-service";

async function context() {
  await requireSession("full");
  return createSupabaseServerClient();
}
const fail = (r: { message: string; details?: string[] }): ActionState => ({
  status: "error",
  message: r.message,
  details: r.details,
});

export async function changeDefaultAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const r = await service.changeCompanyDefault(
    await context(),
    formToObject(form),
  );
  if (!r.ok) return fail(r);
  revalidatePath("/service/config");
  return {
    status: "success",
    message:
      "Company default updated. The previous values are kept as history.",
  };
}

export async function requestOverrideAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const raw = formToObject(form);
  const r = await service.requestOverride(await context(), {
    ...raw,
    clientSubmissionId: raw.clientSubmissionId ?? randomUUID(),
  });
  if (!r.ok) return fail(r);
  revalidatePath("/service/config");
  return {
    status: "success",
    message:
      "Override requested. It only takes effect once a different service configuration manager approves it.",
  };
}

export async function decideOverrideAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const r = await service.decideOverride(await context(), formToObject(form));
  if (!r.ok) return fail(r);
  revalidatePath("/service/config");
  revalidatePath("/vehicles", "layout");
  return {
    status: "success",
    message:
      r.decision === "approved"
        ? "Override approved and now in effect."
        : "Override rejected.",
  };
}

export async function createRecordAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const raw = formToObject(form);
  const r = await service.createRecord(await context(), raw);
  if (!r.ok) return fail(r);
  revalidatePath("/service/verification");
  revalidatePath(`/vehicles/${raw.vehicleId}`);
  return {
    status: "success",
    message:
      "Service recorded. It becomes a baseline only once someone else verifies it.",
  };
}

export async function verifyRecordAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const raw = formToObject(form);
  const r = await service.verifyRecord(await context(), raw);
  if (!r.ok) return fail(r);
  revalidatePath("/service/verification");
  revalidatePath("/vehicles", "layout");
  return {
    status: "success",
    message:
      r.decision === "verified"
        ? "Verified. This is now the vehicle's baseline."
        : "Rejected.",
  };
}

export async function reverseVerificationAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const r = await service.reverseVerification(
    await context(),
    formToObject(form),
  );
  if (!r.ok) return fail(r);
  revalidatePath("/service/verification");
  revalidatePath("/vehicles", "layout");
  return {
    status: "success",
    message: "Verification reversed and recorded in the audit log.",
  };
}

export async function stageImportAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const raw = formToObject(form);
  const r = await service.stageImport(await context(), {
    ...raw,
    clientSubmissionId: raw.clientSubmissionId ?? randomUUID(),
  });
  if (!r.ok) return fail(r);
  revalidatePath("/service/import");
  redirect(`/service/import/${r.batchId}`);
}

export async function attachEvidenceAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const r = await service.attachEvidence(await context(), formToObject(form));
  if (!r.ok) return fail(r);
  revalidatePath(`/service/import/${r.batchId}`);
  revalidatePath("/service/verification");
  return {
    status: "success",
    message:
      "Record created. A different maintenance administrator must now verify it.",
  };
}
