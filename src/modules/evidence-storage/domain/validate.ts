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
  /** DEC-29: where the phone says it was, optional and untrusted. Null when refused, slow or out of range: never blocks. */
  location: CaptureLocation | null;
  /** DEC-06: the phone had no connection when the photo was taken (as it reports). */
  capturedOffline: boolean;
  /** DEC-35: the random key this browser install keeps; untrusted, resolved to a registered device on the server. */
  deviceKey: string | null;
};

export type CaptureLocation = {
  latitude: number;
  longitude: number;
  accuracyM: number | null;
};

/** A usable location only: finite, in range, both coordinates. Anything else is dropped (capture never fails on it). */
export function parseLocation(raw: unknown): CaptureLocation | null {
  if (!raw || typeof raw !== "object") return null;
  const l = raw as Record<string, unknown>;
  const { latitude, longitude, accuracyM } = l;
  if (
    typeof latitude !== "number" ||
    typeof longitude !== "number" ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  )
    return null;
  const acc =
    typeof accuracyM === "number" &&
    Number.isFinite(accuracyM) &&
    accuracyM >= 0 &&
    accuracyM < 1_000_000
      ? Math.round(accuracyM * 10) / 10
      : null;
  return {
    latitude: Math.round(latitude * 1e6) / 1e6,
    longitude: Math.round(longitude * 1e6) / 1e6,
    accuracyM: acc,
  };
}

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
      location: parseLocation(r.location),
      capturedOffline: r.capturedOffline === true,
      deviceKey: isUuid(r.deviceKey) ? r.deviceKey : null,
    },
  };
}
