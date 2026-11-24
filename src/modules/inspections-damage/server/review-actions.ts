"use server";
// The supervisor's evidence actions (PRD §5.8.3, DEC-29). A photo is opened one at a time through the signed-URL path, which
// checks can_view_evidence and writes the access log row; the capture LOCATION is a separate, reviewer-only call that is logged
// too (evidence_capture_location). Both run as the signed-in user: the database is the boundary, this only relays.
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireSession } from "@/modules/identity-access/server/session";
import { createEvidenceDeps } from "@/modules/evidence-storage/server/factory";
import { issueSignedReadUrl } from "@/modules/evidence-storage/server/read-url";
import { isUuid } from "@/modules/evidence-storage/domain/validate";

export async function openInspectionPhotoAction(input: {
  evidenceFileId: string;
  inspectionId: string;
}): Promise<{ ok: true; url: string } | { ok: false; message: string }> {
  await requireSession("full");
  if (!isUuid(input?.evidenceFileId) || !isUuid(input?.inspectionId)) {
    return { ok: false, message: "Invalid photo." };
  }
  const { db, config } = await createEvidenceDeps();
  const r = await issueSignedReadUrl(
    { db, config },
    {
      evidenceFileId: input.evidenceFileId,
      purpose: "inspection review",
      relatedEntityType: "inspection",
      relatedEntityId: input.inspectionId,
    },
  );
  return r.ok ? { ok: true, url: r.url } : { ok: false, message: r.message };
}

export type PhotoLocation =
  | { ok: true; none: true }
  | {
      ok: true;
      none: false;
      latitude: number;
      longitude: number;
      accuracyM: number | null;
    }
  | { ok: false; message: string };

export async function showPhotoLocationAction(input: {
  evidenceFileId: string;
}): Promise<PhotoLocation> {
  await requireSession("full");
  if (!isUuid(input?.evidenceFileId))
    return { ok: false, message: "Invalid photo." };
  const db = await createSupabaseServerClient();
  const { data, error } = await db.rpc("evidence_capture_location", {
    p_evidence_file_id: input.evidenceFileId,
  });
  if (error) {
    return {
      ok: false,
      message: "The location is not available to you for this photo.",
    };
  }
  const row = data?.[0];
  if (!row || row.latitude == null || row.longitude == null) {
    return { ok: true, none: true };
  }
  return {
    ok: true,
    none: false,
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    accuracyM: row.accuracy_m == null ? null : Number(row.accuracy_m),
  };
}
