"use server";
// Server actions = the only entry points the UI uses. Each re-checks the session (including the MFA stage, DEC-34)
// and then runs as the signed-in user, so RLS and the SQL functions authorise. Inputs are validated with zod in
// shift-service. The service-role key is never used here.
import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireSession } from "@/modules/identity-access/server/session";
import type { ActionState } from "@/modules/fleet-vehicles/domain/action-state";
import { formToObject } from "../domain/shift-schema";
import * as service from "./shift-service";

async function context() {
  await requireSession("full");
  return createSupabaseServerClient();
}
const fail = (r: { message: string; details?: string[] }): ActionState => ({
  status: "error",
  message: r.message,
  details: r.details,
});

export async function createTemplateAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const r = await service.createTemplate(await context(), formToObject(form));
  if (!r.ok) return fail(r);
  revalidatePath("/shifts/templates");
  return { status: "success", message: "Shift template created." };
}

export async function updateTemplateAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const r = await service.updateTemplate(await context(), formToObject(form));
  if (!r.ok) return fail(r);
  revalidatePath("/shifts/templates");
  return {
    status: "success",
    message: "Template updated. Shifts already created keep their own times.",
  };
}

export async function archiveTemplateAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const r = await service.archiveTemplate(await context(), formToObject(form));
  if (!r.ok) return fail(r);
  revalidatePath("/shifts/templates");
  return {
    status: "success",
    message: "Template archived. Shifts already created are unchanged.",
  };
}

export async function generateShiftsAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const raw = formToObject(form);
  const r = await service.generateShifts(await context(), {
    ...raw,
    clientSubmissionId: raw.clientSubmissionId ?? randomUUID(),
  });
  if (!r.ok) return fail(r);
  revalidatePath("/shifts");
  return {
    status: "success",
    message: `Created ${r.created} shift${r.created === 1 ? "" : "s"}, skipped ${r.skipped} (already scheduled).`,
  };
}

export async function createShiftAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const raw = formToObject(form);
  const r = await service.createAdHocShift(await context(), {
    ...raw,
    clientSubmissionId: raw.clientSubmissionId ?? randomUUID(),
  });
  if (!r.ok) return fail(r);
  revalidatePath("/shifts");
  return { status: "success", message: "Shift created." };
}

export async function cancelShiftAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const r = await service.cancelShift(await context(), formToObject(form));
  if (!r.ok) return fail(r);
  revalidatePath("/shifts");
  return { status: "success", message: "Shift cancelled." };
}
