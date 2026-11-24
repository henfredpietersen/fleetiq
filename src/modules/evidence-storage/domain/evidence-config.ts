// Evidence handling as configuration (ARCH §6.3, §6.6). Every value is a PROPOSED default that can be
// changed via env; invalid values fail loudly instead of silently weakening a control.
// DEC-29 (EXIF GPS stripping) is Proposed: a flag, default ON. DEC-07 (resolution) is Proposed and not enforced here.

/** Types the server can verify (magic bytes) AND strip metadata from. Also the bucket's DB allow-list. */
export const SUPPORTED_MIME = ["image/jpeg", "image/png"] as const;
export type SupportedMime = (typeof SUPPORTED_MIME)[number];

/** Hard cap = the bucket's file_size_limit (migration 000011). Config can only be stricter. */
export const BUCKET_MAX_BYTES = 15 * 1024 * 1024;

/**
 * In-app camera capture (AD-07, DEC-04, DEC-07). The frame is drawn to a canvas and encoded as JPEG: the long edge is
 * `longEdgePx` (never enlarged), the aspect ratio is kept. DEC-07: the original is the app's capture and is never altered
 * after upload. ONE place for the numbers; the camera and its tests read them from here.
 */
export const CAMERA_CAPTURE = {
  mimeType: "image/jpeg",
  longEdgePx: 1600,
  jpegQuality: 0.85,
  /** One geolocation request when the camera opens; slower than this = no location (never blocks capture). */
  locationTimeoutMs: 4000,
  /** A cached fix younger than this is acceptable. */
  locationMaxAgeMs: 60_000,
} as const;

export type EvidenceConfig = {
  maxBytes: number;
  allowedMime: readonly SupportedMime[];
  /** Lifetime of a signed READ url. Short on purpose. */
  signedUrlMinutes: number;
  /** How long an upload slot stays open (the storage insert policy enforces it). */
  uploadSlotMinutes: number;
  /** DEC-29 (Proposed). When true, the stored file never contains EXIF/XMP GPS. */
  stripExifGps: boolean;
  /** Unregistered uploads are removed this long AFTER their slot expired. Must exceed the signed-upload-URL lifetime (2 h). */
  cleanupGraceMinutes: number;
  cleanupBatchSize: number;
};

export const DEFAULT_EVIDENCE_CONFIG: EvidenceConfig = {
  maxBytes: 10 * 1024 * 1024,
  allowedMime: ["image/jpeg", "image/png"],
  signedUrlMinutes: 5,
  uploadSlotMinutes: 15,
  stripExifGps: true,
  cleanupGraceMinutes: 180,
  cleanupBatchSize: 100,
};

type Env = Record<string, string | undefined>;

function int(
  env: Env,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${key} must be an integer between ${min} and ${max}`);
  }
  return n;
}

function bool(env: Env, key: string, fallback: boolean): boolean {
  const raw = env[key]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return fallback;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  throw new Error(`${key} must be true or false`);
}

function mimeList(env: Env, key: string, fallback: readonly SupportedMime[]) {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const items = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (items.length === 0) throw new Error(`${key} must not be empty`);
  for (const m of items) {
    if (!(SUPPORTED_MIME as readonly string[]).includes(m)) {
      throw new Error(
        `${key}: "${m}" is not supported (supported: ${SUPPORTED_MIME.join(", ")})`,
      );
    }
  }
  return [...new Set(items)] as SupportedMime[];
}

export function loadEvidenceConfig(env: Env = process.env): EvidenceConfig {
  const d = DEFAULT_EVIDENCE_CONFIG;
  return {
    maxBytes: int(
      env,
      "EVIDENCE_MAX_BYTES",
      d.maxBytes,
      1024,
      BUCKET_MAX_BYTES,
    ),
    allowedMime: mimeList(env, "EVIDENCE_ALLOWED_MIME", d.allowedMime),
    signedUrlMinutes: int(
      env,
      "EVIDENCE_SIGNED_URL_MINUTES",
      d.signedUrlMinutes,
      1,
      60,
    ),
    uploadSlotMinutes: int(
      env,
      "EVIDENCE_UPLOAD_SLOT_MINUTES",
      d.uploadSlotMinutes,
      1,
      120,
    ),
    stripExifGps: bool(env, "EVIDENCE_STRIP_EXIF_GPS", d.stripExifGps),
    cleanupGraceMinutes: int(
      env,
      "EVIDENCE_CLEANUP_GRACE_MINUTES",
      d.cleanupGraceMinutes,
      130,
      10080,
    ),
    cleanupBatchSize: int(
      env,
      "EVIDENCE_CLEANUP_BATCH_SIZE",
      d.cleanupBatchSize,
      1,
      1000,
    ),
  };
}
