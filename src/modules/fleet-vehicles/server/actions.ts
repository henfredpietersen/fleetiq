"use server";
// Server actions = the only entry points the UI uses. Each one re-checks the session (including the
// MFA stage, DEC-34) and then runs as the signed-in user, so RLS and the SQL functions authorise.
// Inputs are validated with zod in vehicle-service. The service-role key is never used here.
import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireSession } from "@/modules/identity-access/server/session";
import type { ActionState } from "../domain/action-state";
import { formToObject } from "../domain/vehicle-schema";
import * as service from "./vehicle-service";

async function context() {
  await requireSession("full");
  return createSupabaseServerClient();
}

const fail = (r: { message: string; details?: string[] }): ActionState => ({
  status: "error",
  message: r.message,
  details: r.details,
});

export async function createVehicleAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const db = await context();
  const r = await service.createVehicle(db, formToObject(form));
  if (!r.ok) return fail(r);
  revalidatePath("/vehicles");
  redirect(`/vehicles/${r.id}?created=1`);
}

export async function updateVehicleAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const db = await context();
  const r = await service.updateVehicle(db, formToObject(form));
  if (!r.ok) return fail(r);
  revalidatePath("/vehicles");
  revalidatePath(`/vehicles/${r.id}`);
  return { status: "success", message: "Vehicle details saved." };
}

export async function archiveVehicleAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const db = await context();
  const r = await service.setVehicleArchived(db, formToObject(form));
  if (!r.ok) return fail(r);
  revalidatePath("/vehicles");
  revalidatePath(`/vehicles/${r.id}`);
  return {
    status: "success",
    message: r.archived ? "Vehicle archived." : "Vehicle restored.",
  };
}

export async function requestTransferAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const db = await context();
  const raw = formToObject(form);
  const r = await service.requestTransfer(db, {
    ...raw,
    // the form carries its own id so a retry is idempotent; fall back to a fresh one
    clientSubmissionId: raw.clientSubmissionId ?? randomUUID(),
  });
  if (!r.ok) return fail(r);
  revalidatePath("/vehicles/transfers");
  revalidatePath(`/vehicles/${raw.vehicleId}`);
  return {
    status: "success",
    message:
      "Transfer requested. The vehicle stays where it is until a different fleet administrator approves it.",
  };
}

export async function decideTransferAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const db = await context();
  const r = await service.decideTransfer(db, formToObject(form));
  if (!r.ok) return fail(r);
  revalidatePath("/vehicles");
  revalidatePath("/vehicles/transfers");
  redirect(`/vehicles/transfers?decided=${r.decision}`);
}

export async function cancelTransferAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const db = await context();
  const r = await service.cancelTransfer(db, formToObject(form));
  if (!r.ok) return fail(r);
  revalidatePath("/vehicles/transfers");
  redirect("/vehicles/transfers?decided=cancelled");
}
