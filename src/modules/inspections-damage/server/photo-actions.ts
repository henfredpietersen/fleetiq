"use server";
// The in-app camera's server half (AD-07, DEC-04). Photos for an inspection come from the in-app camera ONLY: this action
// forces captureSource = in_app_camera and a JPEG, and picks the evidence purpose itself. Uploading, registering (type, size,
// hash, metadata strip) and attaching are separate idempotent steps, each with its own client_submission_id; the database
// re-checks DEC-04 on attach (IN010) whatever the client says. Everything runs as the signed-in user.
import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireSession } from "@/modules/identity-access/server/session";
import { createEvidenceDeps } from "@/modules/evidence-storage/server/factory";
import { requestInspectionPhotoSlot } from "./slot-service";
import * as service from "./inspection-service";
import type { InspectionReply } from "./inspection-actions";

async function db() {
  await requireSession("full");
  return createSupabaseServerClient();
}

export async function requestPhotoSlotAction(input: unknown) {
  await requireSession("full");
  const { db: user, config } = await createEvidenceDeps();
  const r = await requestInspectionPhotoSlot({ db: user, config }, input);
  return r.ok
    ? { ok: true as const, slot: r.slot }
    : { ok: false as const, message: r.message };
}

export async function attachOdometerPhotoAction(
  input: unknown,
): Promise<InspectionReply> {
  const r = await service.attachOdometerPhoto(await db(), input);
  if (!r.ok) return { ok: false, message: r.message };
  revalidatePath("/my-allocations");
  return { ok: true, message: "Photo attached." };
}

export async function attachDefectPhotoAction(
  input: unknown,
): Promise<InspectionReply> {
  const r = await service.attachDefectPhoto(await db(), input);
  if (!r.ok) return { ok: false, message: r.message };
  return { ok: true, message: "Photo attached." };
}
