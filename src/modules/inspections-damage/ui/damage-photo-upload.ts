// A damage photo's client-side pipeline (DEC-04/41: in-app camera only): request a slot -> upload to the signed URL -> register.
// There is no "attach" step here: the registered evidence file ids are handed to report_damage() / record_onboarding_damage() together
// with the description, and the database re-checks the photo rules there (camera, purpose, uploader, branch, not used elsewhere).
// Each server step carries its OWN client_submission_id, created once per captured photo and reused on every retry (DEC-06), so a
// dropped connection followed by "Retry" never duplicates a slot or an evidence file. The actions are injected so the flow is testable.
import type { CaptureLocation } from "@/modules/evidence-storage/domain/validate";
import type { CapturedPhoto } from "./photo-upload";

export type DamagePhotoTarget = { inspectionId?: string; vehicleId?: string };
export type PendingDamagePhoto = {
  photo: CapturedPhoto;
  slotSubmissionId: string;
  /** Set once the photo is registered: a retry then skips straight to the report. */
  evidenceFileId?: string;
};
export const newPendingDamagePhoto = (
  photo: CapturedPhoto,
  newId: () => string = () => crypto.randomUUID(),
): PendingDamagePhoto => ({ photo, slotSubmissionId: newId() });

type Slot = {
  slotId: string;
  uploadUrl: string | null;
  alreadyUploaded: boolean;
  alreadyRegistered: boolean;
  evidenceFileId: string | null;
};
export type DamagePhotoApi = {
  requestSlot(
    input: DamagePhotoTarget & {
      sizeBytes: number;
      deviceCaptureAt: string;
      location: CaptureLocation | null;
      capturedOffline: boolean;
      deviceKey: string | null;
      clientSubmissionId: string;
    },
  ): Promise<{ ok: true; slot: Slot } | { ok: false; message: string }>;
  put(url: string, blob: Blob): Promise<boolean>;
  register(
    slotId: string,
  ): Promise<
    | { ok: true; evidence: { evidenceFileId: string } }
    | { ok: false; message: string }
  >;
};
export type DamageSendResult =
  | { ok: true; evidenceFileId: string }
  | { ok: false; message: string; retry: boolean };

export async function sendDamagePhoto(
  p: PendingDamagePhoto,
  ctx: DamagePhotoTarget & { deviceKey: string | null },
  api: DamagePhotoApi,
): Promise<DamageSendResult> {
  if (p.evidenceFileId) return { ok: true, evidenceFileId: p.evidenceFileId };
  const networkFail: DamageSendResult = {
    ok: false,
    message: "The photo has not been sent. Check your signal and tap Retry.",
    retry: true,
  };
  try {
    const slotR = await api.requestSlot({
      inspectionId: ctx.inspectionId,
      vehicleId: ctx.vehicleId,
      sizeBytes: p.photo.blob.size,
      deviceCaptureAt: p.photo.capturedAt,
      location: p.photo.location,
      capturedOffline: p.photo.capturedOffline,
      deviceKey: ctx.deviceKey,
      clientSubmissionId: p.slotSubmissionId,
    });
    if (!slotR.ok) return { ok: false, message: slotR.message, retry: false };
    const slot = slotR.slot;
    let fileId = slot.alreadyRegistered ? slot.evidenceFileId : null;
    if (!fileId) {
      if (!slot.alreadyUploaded) {
        if (!slot.uploadUrl) return networkFail;
        if (!(await api.put(slot.uploadUrl, p.photo.blob))) return networkFail;
      }
      const reg = await api.register(slot.slotId);
      if (!reg.ok) return { ok: false, message: reg.message, retry: true };
      fileId = reg.evidence.evidenceFileId;
    }
    p.evidenceFileId = fileId;
    return { ok: true, evidenceFileId: fileId };
  } catch {
    return networkFail;
  }
}
