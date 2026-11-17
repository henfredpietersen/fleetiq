import { describe, expect, it } from "vitest";
import {
  BUCKET_MAX_BYTES,
  DEFAULT_EVIDENCE_CONFIG,
  loadEvidenceConfig,
} from "./evidence-config";

describe("evidence config", () => {
  it("defaults: GPS stripping ON (DEC-29), short signed URLs, strict limits", () => {
    const c = loadEvidenceConfig({});
    expect(c).toEqual(DEFAULT_EVIDENCE_CONFIG);
    expect(c.stripExifGps).toBe(true);
    expect(c.signedUrlMinutes).toBeLessThanOrEqual(15);
    expect(c.maxBytes).toBeLessThanOrEqual(BUCKET_MAX_BYTES);
  });
  it("reads overrides from env", () => {
    const c = loadEvidenceConfig({
      EVIDENCE_MAX_BYTES: "2000000",
      EVIDENCE_ALLOWED_MIME: "image/jpeg",
      EVIDENCE_SIGNED_URL_MINUTES: "2",
      EVIDENCE_UPLOAD_SLOT_MINUTES: "30",
      EVIDENCE_STRIP_EXIF_GPS: "false",
      EVIDENCE_CLEANUP_GRACE_MINUTES: "240",
    });
    expect(c).toMatchObject({
      maxBytes: 2_000_000,
      allowedMime: ["image/jpeg"],
      signedUrlMinutes: 2,
      uploadSlotMinutes: 30,
      stripExifGps: false,
      cleanupGraceMinutes: 240,
    });
  });
  it("fails loudly on values that would weaken a control", () => {
    expect(() =>
      loadEvidenceConfig({ EVIDENCE_MAX_BYTES: String(BUCKET_MAX_BYTES + 1) }),
    ).toThrow(/EVIDENCE_MAX_BYTES/);
    expect(() =>
      loadEvidenceConfig({ EVIDENCE_SIGNED_URL_MINUTES: "600" }),
    ).toThrow(/EVIDENCE_SIGNED_URL_MINUTES/);
    expect(() =>
      loadEvidenceConfig({ EVIDENCE_SIGNED_URL_MINUTES: "0" }),
    ).toThrow();
    expect(() =>
      loadEvidenceConfig({ EVIDENCE_ALLOWED_MIME: "image/gif" }),
    ).toThrow(/not supported/);
    expect(() =>
      loadEvidenceConfig({ EVIDENCE_ALLOWED_MIME: "application/pdf" }),
    ).toThrow(/not supported/);
    expect(() =>
      loadEvidenceConfig({ EVIDENCE_STRIP_EXIF_GPS: "maybe" }),
    ).toThrow();
    // must exceed the 2 h signed-upload-URL lifetime so cleanup never races a late upload
    expect(() =>
      loadEvidenceConfig({ EVIDENCE_CLEANUP_GRACE_MINUTES: "60" }),
    ).toThrow(/EVIDENCE_CLEANUP_GRACE_MINUTES/);
  });
});
