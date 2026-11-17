import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import type { EvidenceConfig } from "../domain/evidence-config";
import { fail, type EvidenceResult } from "../domain/result";
import { isUuid } from "../domain/validate";
import { mapDbError } from "./db-errors";

export type ReadUrlRequest = {
  evidenceFileId: string;
  /** Why the evidence is being opened (free text, <= 100 chars) — goes in the access log. */
  purpose?: string;
  relatedEntityType?: string;
  relatedEntityId?: string;
};

/**
 * ARCH §6.6 — short-lived signed READ url. Order matters and is fail-closed:
 *   1. issue_evidence_access(): evidence.view check in scope (has_permission + Own/Branch/All) AND the
 *      evidence_access_log row, in one database call. Refused -> nothing is logged, no path is returned.
 *   2. only then is the signed URL minted, with the USER's client (storage SELECT policy mirrors the same RLS).
 * No elevated key on this path.
 */
export async function issueSignedReadUrl(
  deps: { db: SupabaseClient<Database>; config: EvidenceConfig },
  req: ReadUrlRequest,
): Promise<EvidenceResult<{ url: string; expiresInSeconds: number }>> {
  if (!isUuid(req.evidenceFileId)) {
    return fail("INVALID_INPUT", "Invalid evidence id.");
  }
  if (req.relatedEntityId !== undefined && !isUuid(req.relatedEntityId)) {
    return fail("INVALID_INPUT", "Invalid related entity.");
  }
  const { data, error } = await deps.db.rpc("issue_evidence_access", {
    p_evidence_file_id: req.evidenceFileId,
    p_purpose: req.purpose?.slice(0, 100) ?? "view",
    p_related_entity_type: req.relatedEntityType?.slice(0, 100),
    p_related_entity_id: req.relatedEntityId,
  });
  if (error) {
    const f = mapDbError(error);
    // not visible and not existing look the same to the caller
    return f.code === "FORBIDDEN"
      ? fail("FORBIDDEN", "Evidence not available.")
      : f;
  }
  const target = data?.[0];
  if (!target) return fail("FORBIDDEN", "Evidence not available.");

  const expiresInSeconds = deps.config.signedUrlMinutes * 60;
  const signed = await deps.db.storage
    .from(target.bucket)
    .createSignedUrl(target.object_path, expiresInSeconds);
  if (signed.error || !signed.data?.signedUrl) {
    return fail("UNAVAILABLE", "Could not open the evidence. Try again.");
  }
  return { ok: true, url: signed.data.signedUrl, expiresInSeconds };
}
