// The driver's photo pipeline, client side (AD-07, ARCH §6.3): request a slot -> upload to the signed URL -> register (the server
// re-checks type, size, hash and strips metadata) -> attach to the inspection. Each server step carries its OWN
// client_submission_id, created once per captured photo and reused on every retry, so a dropped connection followed by "Retry"
// never duplicates a slot, an evidence file or an attachment (DEC-06). The photo stays in memory (PendingPhoto) until it is
// attached or the driver retakes. The actions are injected so the whole flow is testable without a browser.
import type { CaptureLocation } from "@/modules/evidence-storage/domain/validate";

export type PhotoTarget =
  { kind: "odometer" } | { kind: "defect"; templateItemId: string };

export type CapturedPhoto = {
  blob: Blob;
  width: number;
  height: number;
  /** The moment of the shutter on the phone's clock: untrusted (ARCH §6.7). */
  capturedAt: string;
  location: CaptureLocation | null;
  capturedOffline: boolean;
};

export type PendingPhoto = {
  photo: CapturedPhoto;
  target: PhotoTarget;
  /** Step 1 (slot) and step 4 (attach) ids. Register is idempotent per slot and needs none of its own. */
  slotSubmissionId: string;
  attachSubmissionId: string;
};

export const newPendingPhoto = (
  photo: CapturedPhoto,
  target: PhotoTarget,
  newId: () => string = () => crypto.randomUUID(),
): PendingPhoto => ({
  photo,
  target,
  slotSubmissionId: newId(),
  attachSubmissionId: newId(),
});

type Slot = {
  slotId: string;
  uploadUrl: string | null;
  alreadyUploaded: boolean;
  alreadyRegistered: boolean;
  evidenceFileId: string | null;
};
export type PhotoApi = {
  requestSlot(input: {
    inspectionId: string;
    kind: "odometer" | "defect";
    sizeBytes: number;
    deviceCaptureAt: string;
    location: CaptureLocation | null;
    capturedOffline: boolean;
    deviceKey: string | null;
    clientSubmissionId: string;
  }): Promise<{ ok: true; slot: Slot } | { ok: false; message: string }>;
  put(url: string, blob: Blob): Promise<boolean>;
  register(
    slotId: string,
  ): Promise<
    | { ok: true; evidence: { evidenceFileId: string } }
    | { ok: false; message: string }
  >;
  attach(input: {
    inspectionId: string;
    evidenceFileId: string;
    templateItemId?: string;
    kind: "odometer" | "defect";
    clientSubmissionId: string;
  }): Promise<{ ok: boolean; message: string }>;
};

export type SendResult =
  | { ok: true }
  /** `retry` = nothing the driver did wrong (network, server hiccup): offer "Not sent — Retry". Otherwise show the message. */
  | { ok: false; message: string; retry: boolean };

export const NOT_SENT = "Not sent — Retry";

export async function sendPhoto(
  p: PendingPhoto,
  ctx: { inspectionId: string; deviceKey: string | null },
  api: PhotoApi,
): Promise<SendResult> {
  const networkFail: SendResult = {
    ok: false,
    message: "The photo has not been sent. Check your signal and tap Retry.",
    retry: true,
  };
  try {
    const slotR = await api.requestSlot({
      inspectionId: ctx.inspectionId,
      kind: p.target.kind,
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
    const att = await api.attach({
      inspectionId: ctx.inspectionId,
      evidenceFileId: fileId,
      templateItemId:
        p.target.kind === "defect" ? p.target.templateItemId : undefined,
      kind: p.target.kind,
      clientSubmissionId: p.attachSubmissionId,
    });
    return att.ok
      ? { ok: true }
      : { ok: false, message: att.message, retry: false };
  } catch {
    // a thrown fetch / server-action call = no connection
    return networkFail;
  }
}
