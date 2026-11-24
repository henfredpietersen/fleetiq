"use server";
// Server actions for inspections: the only entry points the UI uses. Each re-checks the session (including MFA for staff,
// DEC-34) and runs as the signed-in user, so RLS and the SQL functions authorise. The service-role key is never used here.
// Idempotent: the client sends the same clientSubmissionId on every retry.
import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireSession } from "@/modules/identity-access/server/session";
import * as service from "./inspection-service";

export type InspectionReply =
  | {
      ok: true;
      message: string;
      lateFlag?: boolean;
      safetyDefectFlag?: boolean;
    }
  | { ok: false; message: string };

async function db() {
  await requireSession("full");
  return createSupabaseServerClient();
}

export async function beginInspectionAction(input: {
  allocationId: string;
  stage: "pre_shift" | "post_shift";
  deviceStartedAt?: string;
  capturedOffline?: boolean;
  clientSubmissionId: string;
}): Promise<InspectionReply> {
  const r = await service.beginInspection(await db(), input);
  if (!r.ok) return { ok: false, message: r.message };
  revalidatePath("/my-allocations");
  return { ok: true, message: "Inspection started." };
}

export async function saveAnswersAction(input: {
  inspectionId: string;
  responses: {
    templateItemId: string;
    value: string;
    comment?: string;
    deviceAnsweredAt?: string;
  }[];
  vehicleConfirmed?: boolean;
  clientSubmissionId: string;
}): Promise<InspectionReply> {
  const r = await service.saveResponses(await db(), input);
  if (!r.ok) return { ok: false, message: r.message };
  return { ok: true, message: "Answers saved." };
}

export async function submitInspectionAction(input: {
  inspectionId: string;
  deviceSubmittedAt?: string;
  capturedOffline?: boolean;
  clientSubmissionId: string;
}): Promise<InspectionReply> {
  const r = await service.submitInspection(await db(), input);
  if (!r.ok) return { ok: false, message: r.message };
  revalidatePath("/my-allocations");
  revalidatePath("/inspections");
  return {
    ok: true,
    message: "Inspection submitted.",
    lateFlag: r.lateFlag,
    safetyDefectFlag: r.safetyDefectFlag,
  };
}
