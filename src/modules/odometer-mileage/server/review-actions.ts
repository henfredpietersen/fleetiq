"use server";
// Server actions for the odometer review (the only entry points the UI uses). Each re-checks the session (MFA for staff, DEC-34) and runs
// as the signed-in user, so RLS and the SQL functions authorise. The service-role key is never used here.
import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireSession } from "@/modules/identity-access/server/session";
import { createEvidenceDeps } from "@/modules/evidence-storage/server/factory";
import { issueSignedReadUrl } from "@/modules/evidence-storage/server/read-url";
import { isUuid } from "@/modules/evidence-storage/domain/validate";
import type { ItemResult } from "../domain/review-types";
import * as service from "./review-service";
import * as settings from "./settings-service";

async function db() {
  await requireSession("full");
  return createSupabaseServerClient();
}

export type QuickCheckReply =
  | { ok: true; results: ItemResult[]; accepted: number; refused: number }
  | { ok: false; message: string };

export async function quickCheckAcceptAction(input: {
  items: { readingId: string; validatedAt: string }[];
  clientSubmissionId: string;
}): Promise<QuickCheckReply> {
  const r = await service.quickCheckAccept(await db(), input);
  if (!r.ok) return { ok: false, message: r.message };
  revalidatePath("/odometer/review");
  return {
    ok: true,
    results: r.results,
    accepted: r.accepted,
    refused: r.refused,
  };
}

export type SimpleReply =
  { ok: true; message: string } | { ok: false; message: string };

export async function sendToFullReviewAction(input: {
  readingId: string;
  note: string;
  clientSubmissionId: string;
}): Promise<SimpleReply> {
  const r = await service.sendToFullReview(await db(), input);
  if (!r.ok) return { ok: false, message: r.message };
  revalidatePath("/odometer/review");
  return { ok: true, message: "Sent to full review." };
}

export async function reviewReadingAction(input: {
  readingId: string;
  decision: "accept" | "accept_value" | "reject";
  acceptedKm?: number | null;
  reason: string;
  clientSubmissionId: string;
}): Promise<SimpleReply> {
  const r = await service.reviewReading(await db(), input);
  if (!r.ok) return { ok: false, message: r.message };
  revalidatePath("/odometer/review");
  return {
    ok: true,
    message:
      input.decision === "reject"
        ? "The reading was rejected."
        : "The reading was accepted.",
  };
}

/** The odometer photo, through the existing signed-URL path: can_view_evidence is checked and the access is logged (ARCH §6.6). */
export async function openReadingPhotoAction(input: {
  evidenceFileId: string;
  readingId: string;
}): Promise<{ ok: true; url: string } | { ok: false; message: string }> {
  await requireSession("full");
  if (!isUuid(input?.evidenceFileId) || !isUuid(input?.readingId))
    return { ok: false, message: "Invalid photo." };
  const { db: client, config } = await createEvidenceDeps();
  const r = await issueSignedReadUrl(
    { db: client, config },
    {
      evidenceFileId: input.evidenceFileId,
      purpose: "odometer reading review",
      relatedEntityType: "odometer_reading",
      relatedEntityId: input.readingId,
    },
  );
  return r.ok ? { ok: true, url: r.url } : { ok: false, message: r.message };
}

export async function saveSettingsAction(
  input: Record<string, unknown>,
): Promise<SimpleReply> {
  const r = await settings.saveSettings(await db(), input);
  if (!r.ok)
    return { ok: false, message: [r.message, ...(r.details ?? [])].join(" ") };
  revalidatePath("/settings/validation");
  return { ok: true, message: "The settings were saved as a new version." };
}
