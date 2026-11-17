import type { EvidenceConfig, SupportedMime } from "./evidence-config";
import {
  CLIENT_CAPTURE_SOURCES,
  isEvidencePurpose,
  type ClientCaptureSource,
  type EvidencePurpose,
} from "./purposes";
import { fail, type EvidenceResult } from "./result";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string =>
  typeof v === "string" && UUID.test(v);

export type UploadSlotRequest = {
  purpose: EvidencePurpose;
  /** Branch the evidence belongs to; null = company-level (needs a company-wide grant). */
  branchId: string | null;
  captureSource: ClientCaptureSource;
  mimeType: SupportedMime;
  sizeBytes: number;
  /** Client-generated idempotency key: a retry must reuse it. */
  clientSubmissionId: string;
  /** Untrusted device time (ARCH §6.7); stored as declared, never used for decisions. */
  deviceCaptureAt: string | null;
};

/** Early, friendly validation. The database and the registration step re-check everything. */
export function validateSlotRequest(
  raw: unknown,
  config: EvidenceConfig,
): EvidenceResult<{ value: UploadSlotRequest }> {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (!isEvidencePurpose(r.purpose)) {
    return fail("INVALID_INPUT", "Unknown evidence purpose.");
  }
  if (r.branchId !== null && r.branchId !== undefined && !isUuid(r.branchId)) {
    return fail("INVALID_INPUT", "Invalid branch.");
  }
  if (
    typeof r.captureSource !== "string" ||
    !(CLIENT_CAPTURE_SOURCES as readonly string[]).includes(r.captureSource)
  ) {
    return fail("INVALID_INPUT", "Invalid capture source.");
  }
  if (
    typeof r.mimeType !== "string" ||
    !(config.allowedMime as readonly string[]).includes(r.mimeType)
  ) {
    return fail("MIME_NOT_ALLOWED", "This file type is not accepted.");
  }
  if (
    typeof r.sizeBytes !== "number" ||
    !Number.isInteger(r.sizeBytes) ||
    r.sizeBytes < 1
  ) {
    return fail("INVALID_INPUT", "Invalid file size.");
  }
  if (r.sizeBytes > config.maxBytes) {
    return fail("TOO_LARGE", "The file is too large.");
  }
  if (!isUuid(r.clientSubmissionId)) {
    return fail("INVALID_INPUT", "clientSubmissionId must be a UUID.");
  }
  let deviceCaptureAt: string | null = null;
  if (r.deviceCaptureAt !== null && r.deviceCaptureAt !== undefined) {
    const t =
      typeof r.deviceCaptureAt === "string"
        ? Date.parse(r.deviceCaptureAt)
        : NaN;
    if (Number.isNaN(t)) {
      return fail("INVALID_INPUT", "Invalid device capture time.");
    }
    deviceCaptureAt = new Date(t).toISOString();
  }
  return {
    ok: true,
    value: {
      purpose: r.purpose,
      branchId: (r.branchId as string | null | undefined) ?? null,
      captureSource: r.captureSource as ClientCaptureSource,
      mimeType: r.mimeType as SupportedMime,
      sizeBytes: r.sizeBytes,
      clientSubmissionId: r.clientSubmissionId,
      deviceCaptureAt,
    },
  };
}
