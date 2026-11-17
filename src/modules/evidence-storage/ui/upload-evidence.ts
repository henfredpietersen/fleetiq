// Client-side half of the 1C evidence flow, shared by the forms that attach a photo (service records, baseline
// import): the server issues a slot at a server-chosen private path -> the browser PUTs the file to the signed URL ->
// the server verifies, strips metadata and registers it. Nothing here chooses a path or holds an elevated key.
// A retry reuses the same client submission id (idempotent).
import {
  registerEvidenceUploadAction,
  requestEvidenceUploadAction,
} from "../server/actions";

export type UploadResult =
  { ok: true; evidenceFileId: string } | { ok: false; message: string };

export async function uploadEvidencePhoto(args: {
  file: File;
  purpose: "service_record";
  branchId: string;
  submissionId: string;
}): Promise<UploadResult> {
  const slotResult = await requestEvidenceUploadAction({
    purpose: args.purpose,
    branchId: args.branchId,
    captureSource: "file_upload",
    mimeType: args.file.type,
    sizeBytes: args.file.size,
    clientSubmissionId: args.submissionId,
  });
  if (!slotResult.ok) return { ok: false, message: slotResult.message };
  const { slot } = slotResult;
  if (slot.alreadyRegistered && slot.evidenceFileId)
    return { ok: true, evidenceFileId: slot.evidenceFileId };
  if (!slot.alreadyUploaded) {
    if (!slot.uploadUrl)
      return { ok: false, message: "Could not prepare the upload. Try again." };
    const body = new FormData();
    body.append("cacheControl", "3600");
    body.append("", args.file);
    const put = await fetch(slot.uploadUrl, { method: "PUT", body });
    if (!put.ok)
      return {
        ok: false,
        message:
          "The photo could not be uploaded. Check your connection and try again.",
      };
  }
  const reg = await registerEvidenceUploadAction({ slotId: slot.slotId });
  if (!reg.ok) return { ok: false, message: reg.message };
  return { ok: true, evidenceFileId: reg.evidence.evidenceFileId };
}
