"use server";
// Server actions for the damage register, damage photos and the on-behalf start (DEC-42, DEC-09). Each re-checks the session
// (including MFA for staff, DEC-34) and runs as the signed-in user, so RLS and the SQL functions authorise. The service-role key is
// never used here. Damage photos come from the in-app camera ONLY: the slot action forces captureSource = in_app_camera and
// purpose = damage (DEC-04/41). Idempotent: the client sends the same clientSubmissionId on every retry (DEC-06).
import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireSession } from "@/modules/identity-access/server/session";
import { createEvidenceDeps } from "@/modules/evidence-storage/server/factory";
import { requestUploadSlot } from "@/modules/evidence-storage/server/request-upload";
import { issueSignedReadUrl } from "@/modules/evidence-storage/server/read-url";
import { isUuid } from "@/modules/evidence-storage/domain/validate";
import { damageSlotSchema, parseInput } from "../domain/damage-schema";
import * as damage from "./damage-service";
import * as service from "./inspection-service";

export type DamageReply =
  { ok: true; message: string; id?: string } | { ok: false; message: string };

async function db() {
  await requireSession("full");
  return createSupabaseServerClient();
}

/** A damage photo's upload slot: for a draft inspection (its branch) or, for the day-one load, a vehicle (its branch). */
export async function requestDamageSlotAction(input: unknown) {
  const p = parseInput(damageSlotSchema, input);
  if (!p.ok) return { ok: false as const, message: p.message };
  if (!!p.value.inspectionId === !!p.value.vehicleId)
    return { ok: false as const, message: "Invalid request." };
  const user = await db();
  let branchId: string;
  if (p.value.inspectionId) {
    const b = await service.inspectionBranch(user, p.value.inspectionId);
    if (!b.ok) return { ok: false as const, message: b.message };
    branchId = b.branchId;
  } else {
    const { data } = await user
      .from("vehicles")
      .select("current_branch_id")
      .eq("id", p.value.vehicleId!)
      .maybeSingle();
    if (!data?.current_branch_id)
      return {
        ok: false as const,
        message: "That vehicle was not found, or you cannot access it.",
      };
    branchId = data.current_branch_id;
  }
  const { db: evDb, config } = await createEvidenceDeps();
  const r = await requestUploadSlot(
    { db: evDb, config },
    {
      purpose: "damage",
      branchId,
      captureSource: "in_app_camera",
      mimeType: "image/jpeg",
      sizeBytes: p.value.sizeBytes,
      clientSubmissionId: p.value.clientSubmissionId,
      deviceCaptureAt: p.value.deviceCaptureAt ?? null,
      location: p.value.location ?? null,
      capturedOffline: p.value.capturedOffline,
      deviceKey: p.value.deviceKey ?? null,
    },
  );
  return r.ok
    ? { ok: true as const, slot: r.slot }
    : { ok: false as const, message: r.message };
}

export async function confirmKnownDamageAction(
  input: unknown,
): Promise<DamageReply> {
  const r = await service.confirmKnownDamage(await db(), input);
  if (!r.ok) return { ok: false, message: r.message };
  return { ok: true, message: "Known damage list confirmed." };
}

export async function reportDamageAction(input: unknown): Promise<DamageReply> {
  const r = await damage.reportDamage(await db(), input);
  if (!r.ok) return { ok: false, message: r.message };
  revalidatePath("/shifts/inspections");
  return { ok: true, message: "Damage reported.", id: r.damageId };
}

export async function recordOnboardingDamageAction(
  input: unknown,
): Promise<DamageReply> {
  const r = await damage.recordOnboardingDamage(await db(), input);
  if (!r.ok) return { ok: false, message: r.message };
  revalidatePath("/vehicles");
  return { ok: true, message: "Existing damage recorded.", id: r.damageId };
}

export async function reviewDamageAction(input: unknown): Promise<DamageReply> {
  const r = await damage.reviewDamage(await db(), input);
  if (!r.ok) return { ok: false, message: r.message };
  revalidatePath("/vehicles");
  return { ok: true, message: "Saved." };
}

export async function markDamageRepairedAction(
  input: unknown,
): Promise<DamageReply> {
  const r = await damage.markDamageRepaired(await db(), input);
  if (!r.ok) return { ok: false, message: r.message };
  revalidatePath("/vehicles");
  return { ok: true, message: "Marked repaired." };
}

/** DEC-09: begin the post-shift inspection on the driver's behalf; the form is then opened at /shifts/allocations/<id>/on-behalf. */
export async function beginOnBehalfAction(
  input: unknown,
): Promise<DamageReply> {
  const r = await service.beginInspectionOnBehalf(await db(), input);
  if (!r.ok) return { ok: false, message: r.message };
  revalidatePath("/shifts/allocations");
  return {
    ok: true,
    message: "Started on the driver's behalf.",
    id: r.inspectionId,
  };
}

export async function voidInspectionAction(
  input: unknown,
): Promise<DamageReply> {
  const r = await service.voidInspection(await db(), input);
  if (!r.ok) return { ok: false, message: r.message };
  revalidatePath("/shifts/inspections");
  revalidatePath("/shifts/allocations");
  return { ok: true, message: "Inspection voided." };
}

/** A damage photo, opened one at a time through the signed-URL path (can_view_evidence + the access log). */
export async function openDamagePhotoAction(input: {
  evidenceFileId: string;
  damageItemId: string;
}): Promise<{ ok: true; url: string } | { ok: false; message: string }> {
  await requireSession("full");
  if (!isUuid(input?.evidenceFileId) || !isUuid(input?.damageItemId))
    return { ok: false, message: "Invalid photo." };
  const { db: evDb, config } = await createEvidenceDeps();
  const r = await issueSignedReadUrl(
    { db: evDb, config },
    {
      evidenceFileId: input.evidenceFileId,
      purpose: "damage review",
      relatedEntityType: "vehicle_damage_item",
      relatedEntityId: input.damageItemId,
    },
  );
  return r.ok ? { ok: true, url: r.url } : { ok: false, message: r.message };
}
