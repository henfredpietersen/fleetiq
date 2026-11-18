"use server";
// Server actions for allocations: the only entry points the UI uses. Each re-checks the session (including MFA,
// DEC-34) and runs as the signed-in user, so RLS and the SQL functions authorise. zod runs in allocation-service.
// The service-role key is never used here.
import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireSession } from "@/modules/identity-access/server/session";
import type { ActionState } from "@/modules/fleet-vehicles/domain/action-state";
import { formToObject } from "../domain/allocation-schema";
import type { EligibilityResult } from "../domain/allocation-text";
import * as service from "./allocation-service";

async function context() {
  await requireSession("full");
  return createSupabaseServerClient();
}
const fail = (r: { message: string; details?: string[] }): ActionState => ({
  status: "error",
  message: r.message,
  details: r.details,
});

export type EligibilityReply =
  { ok: true; result: EligibilityResult } | { ok: false; message: string };

/** Called by the allocate dialog as the user picks a shift, vehicle and driver. Read-only. */
export async function checkEligibilityAction(input: {
  shiftId: string;
  vehicleId: string;
  driverId: string;
}): Promise<EligibilityReply> {
  const r = await service.checkEligibility(await context(), input);
  return r.ok
    ? { ok: true, result: r.result }
    : { ok: false, message: r.message };
}

export async function requestAllocationAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const raw = formToObject(form);
  const r = await service.requestAllocation(await context(), {
    ...raw,
    clientSubmissionId: raw.clientSubmissionId ?? randomUUID(),
  });
  if (!r.ok) return fail(r);
  revalidatePath("/shifts/allocations");
  revalidatePath("/shifts/allocations/overrides");
  return r.allocationId
    ? { status: "success", message: "Allocation created." }
    : {
        status: "success",
        message:
          "Sent for approval. The allocation is created only if another manager approves the licence override.",
      };
}

export async function decideOverrideAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const raw = formToObject(form);
  const r = await service.decideLicenceOverride(await context(), raw);
  if (!r.ok) return fail(r);
  revalidatePath("/shifts/allocations");
  revalidatePath("/shifts/allocations/overrides");
  return {
    status: "success",
    message:
      raw.decision === "approved"
        ? "Approved. The allocation was created."
        : "Rejected. No allocation was created.",
  };
}

export async function setRequiredLicenceCodeAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const raw = formToObject(form);
  const r = await service.setRequiredLicenceCode(await context(), raw);
  if (!r.ok) return fail(r);
  if (typeof raw.vehicleId === "string")
    revalidatePath(`/vehicles/${raw.vehicleId}`);
  return { status: "success", message: "Required licence code saved." };
}
