import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import type { EvidenceConfig } from "../domain/evidence-config";
import { readDimensions, sha256Hex, sniffMime } from "../domain/image";
import { UPLOAD_PERMISSION, isEvidencePurpose } from "../domain/purposes";
import { fail, type EvidenceResult } from "../domain/result";
import { MetadataError, stripMetadata } from "../domain/strip-metadata";
import { isUuid } from "../domain/validate";
import { mapDbError } from "./db-errors";

type Db = SupabaseClient<Database>;

export type RegisteredEvidence = {
  evidenceFileId: string;
  alreadyRegistered: boolean;
  /** Present on a fresh registration only. */
  sha256?: string;
  mimeType?: string;
  sizeBytes?: number;
  width?: number | null;
  height?: number | null;
  exifGpsStripped?: boolean;
};

/**
 * ARCH §6.3 steps 3–4 — verify, then register. A REVIEWED ADMIN FUNCTION (ARCH §5.3): it uses the
 * service-role client, but only after the caller was authenticated and authorised as the user, and
 * only for the slot that user owns. The caller supplies a slot id and nothing else: the object path,
 * declared type and purpose all come from the database row the server created.
 *
 * Idempotent: a retry of a registered slot returns the same evidence id without touching storage.
 */
export async function registerUpload(
  deps: { db: Db; admin: () => Db; config: EvidenceConfig },
  input: { slotId: unknown },
): Promise<EvidenceResult<{ evidence: RegisteredEvidence }>> {
  if (!isUuid(input.slotId)) return fail("INVALID_INPUT", "Invalid upload.");
  const { db, config } = deps;

  // 1. Who is calling? (verified by the auth server, not read from a cookie.)
  const { data: userData, error: userErr } = await db.auth.getUser();
  const userId = userData?.user?.id;
  if (userErr || !userId) return fail("UNAUTHENTICATED", "Sign in first.");

  // 2. The slot, under RLS: only the requester can see it. Another user's id looks like "not found".
  const { data: slot, error: slotErr } = await db
    .from("evidence_upload_slots")
    .select("*")
    .eq("id", input.slotId)
    .maybeSingle();
  if (slotErr) return mapDbError(slotErr);
  if (!slot) return fail("NOT_FOUND", "Upload not found.");

  if (slot.status === "registered" && slot.evidence_file_id) {
    return {
      ok: true,
      evidence: {
        evidenceFileId: slot.evidence_file_id,
        alreadyRegistered: true,
      },
    };
  }
  if (slot.status !== "issued") {
    return fail("SLOT_UNAVAILABLE", "This upload can no longer be completed.");
  }
  if (Date.parse(slot.expires_at) <= Date.now()) {
    return fail("SLOT_EXPIRED", "The upload window has expired. Start again.");
  }

  // 3. Still permitted right now? (grants can end between slot and registration.)
  if (!isEvidencePurpose(slot.purpose)) {
    return fail("INVALID_INPUT", "Unknown evidence purpose.");
  }
  const { data: allowed, error: permErr } = await db.rpc("has_permission", {
    permission_key: UPLOAD_PERMISSION[slot.purpose],
    target_branch_id: slot.branch_id as string,
  });
  if (permErr) return mapDbError(permErr);
  if (!allowed) return fail("FORBIDDEN", "You are not allowed to do this.");

  // 4. Verify the object at the server-chosen path (service role from here on).
  const admin = deps.admin();
  const store = admin.storage.from(slot.bucket);

  const info = await store.info(slot.object_path);
  if (info.error || !info.data) {
    const status = String(
      (info.error as { statusCode?: string | number } | null)?.statusCode ?? "",
    );
    return status === "404" || /not found/i.test(info.error?.message ?? "")
      ? fail("OBJECT_MISSING", "The file was not uploaded.")
      : fail("UNAVAILABLE", "Evidence storage is temporarily unavailable.");
  }
  if ((info.data.size ?? 0) > config.maxBytes) {
    return fail("TOO_LARGE", "The file is too large."); // checked BEFORE downloading it
  }

  const dl = await store.download(slot.object_path);
  if (dl.error || !dl.data) {
    return fail("UNAVAILABLE", "Evidence storage is temporarily unavailable.");
  }
  const original = new Uint8Array(await dl.data.arrayBuffer());
  if (original.length === 0) return fail("EMPTY_FILE", "The file is empty.");
  if (original.length > config.maxBytes) {
    return fail("TOO_LARGE", "The file is too large.");
  }

  // Type from the bytes, never from the client or the object's Content-Type header.
  const mime = sniffMime(original);
  if (!mime || !config.allowedMime.includes(mime)) {
    return fail("MIME_NOT_ALLOWED", "This file type is not accepted.");
  }
  if (mime !== slot.declared_mime_type) {
    return fail("MIME_MISMATCH", "The file is not the type that was declared.");
  }

  // DEC-29 (Proposed, flag): strip EXIF/XMP GPS. If it cannot be done safely the upload is refused.
  let stored = original;
  if (config.stripExifGps) {
    try {
      const result = stripMetadata(original, mime);
      stored = result.bytes;
      if (result.changed) {
        const up = await store.upload(slot.object_path, stored, {
          contentType: mime,
          upsert: true,
        });
        if (up.error) {
          return fail(
            "UNAVAILABLE",
            "Evidence storage is temporarily unavailable.",
          );
        }
      }
    } catch (e) {
      if (e instanceof MetadataError) {
        return fail("INVALID_IMAGE", "The image is damaged or incomplete.");
      }
      throw e;
    }
  }

  // 5. Hash what is STORED, computed here — never a client-supplied value.
  const sha256 = sha256Hex(stored);
  const dims = readDimensions(stored, mime);

  // 6. Register (service-role-only SQL function; idempotent per slot; audited).
  const { data: fileId, error: regErr } = await admin.rpc(
    "register_evidence_file",
    {
      p_slot_id: slot.id,
      p_user_id: userId,
      p_sha256: sha256,
      p_mime_type: mime,
      p_size_bytes: stored.length,
      p_width: (dims?.width ?? null) as number,
      p_height: (dims?.height ?? null) as number,
      p_exif_gps_stripped: config.stripExifGps,
    },
  );
  if (regErr || !fileId)
    return regErr
      ? mapDbError(regErr)
      : fail("UNAVAILABLE", "Evidence storage is temporarily unavailable.");

  return {
    ok: true,
    evidence: {
      evidenceFileId: fileId,
      alreadyRegistered: false,
      sha256,
      mimeType: mime,
      sizeBytes: stored.length,
      width: dims?.width ?? null,
      height: dims?.height ?? null,
      exifGpsStripped: config.stripExifGps,
    },
  };
}
