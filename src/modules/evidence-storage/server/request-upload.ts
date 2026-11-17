import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import type { EvidenceConfig } from "../domain/evidence-config";
import { fail, type EvidenceResult } from "../domain/result";
import { validateSlotRequest } from "../domain/validate";
import { mapDbError } from "./db-errors";

export type UploadSlot = {
  slotId: string;
  bucket: string;
  /** Server-chosen. The client never supplies or alters it. */
  objectPath: string;
  /** Signed upload URL + token (storage-js `uploadToSignedUrl`). Null when there is nothing left to upload. */
  uploadUrl: string | null;
  token: string | null;
  expiresAt: string;
  /** The object is already in storage (a retry after a successful upload): go straight to registration. */
  alreadyUploaded: boolean;
  /** Already registered (a retry after success): nothing more to do. */
  alreadyRegistered: boolean;
  evidenceFileId: string | null;
};

/**
 * ARCH §6.3 step 1 — the server issues a signed upload URL to a server-chosen private path, after a
 * permission check. Runs entirely as the USER (RLS + storage policy): no elevated key on this path.
 * Idempotent on `clientSubmissionId`.
 */
export async function requestUploadSlot(
  deps: { db: SupabaseClient<Database>; config: EvidenceConfig },
  raw: unknown,
): Promise<EvidenceResult<{ slot: UploadSlot }>> {
  const v = validateSlotRequest(raw, deps.config);
  if (!v.ok) return v;
  const req = v.value;

  const { data, error } = await deps.db.rpc("request_evidence_upload_slot", {
    p_purpose: req.purpose,
    p_branch_id: req.branchId as string, // nullable in SQL; generated type is non-null
    p_capture_source: req.captureSource,
    p_mime_type: req.mimeType,
    p_size_bytes: req.sizeBytes,
    p_client_submission_id: req.clientSubmissionId,
    p_device_capture_at: req.deviceCaptureAt ?? undefined,
    p_ttl_minutes: deps.config.uploadSlotMinutes,
  });
  if (error) return mapDbError(error);
  if (!data)
    return fail("UNAVAILABLE", "Evidence storage is temporarily unavailable.");

  const base = {
    slotId: data.id,
    bucket: data.bucket,
    objectPath: data.object_path,
    expiresAt: data.expires_at,
    evidenceFileId: data.evidence_file_id,
  };
  if (data.status === "registered") {
    return {
      ok: true,
      slot: {
        ...base,
        uploadUrl: null,
        token: null,
        alreadyUploaded: true,
        alreadyRegistered: true,
      },
    };
  }

  const signed = await deps.db.storage
    .from(data.bucket)
    .createSignedUploadUrl(data.object_path);
  if (signed.error) {
    const status = String(
      (signed.error as { statusCode?: string | number }).statusCode ?? "",
    );
    // "resource already exists": the earlier attempt did upload — the client should just register.
    if (status === "409" || /already exists/i.test(signed.error.message)) {
      return {
        ok: true,
        slot: {
          ...base,
          uploadUrl: null,
          token: null,
          alreadyUploaded: true,
          alreadyRegistered: false,
        },
      };
    }
    return fail("UNAVAILABLE", "Could not prepare the upload. Try again.");
  }
  return {
    ok: true,
    slot: {
      ...base,
      uploadUrl: signed.data.signedUrl,
      token: signed.data.token,
      alreadyUploaded: false,
      alreadyRegistered: false,
    },
  };
}
