// A photo as it comes out of the in-app camera (AD-07, DEC-04). Inspection photos no longer have their own client pipeline: they are
// stored on the phone and sent by the offline queue (offline/domain/runner.ts: slot -> upload -> register -> attach, each step with
// its own client_submission_id, retried with the same ids). This type is shared with the day-one damage photo flow.
import type { CaptureLocation } from "@/modules/evidence-storage/domain/validate";

export type CapturedPhoto = {
  blob: Blob;
  width: number;
  height: number;
  /** The moment of the shutter on the phone's clock: untrusted (ARCH §6.7). */
  capturedAt: string;
  location: CaptureLocation | null;
  capturedOffline: boolean;
};
