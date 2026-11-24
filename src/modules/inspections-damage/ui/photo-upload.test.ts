import { describe, expect, it, vi } from "vitest";
import {
  newPendingPhoto,
  sendPhoto,
  type CapturedPhoto,
  type PhotoApi,
} from "./photo-upload";

const photo: CapturedPhoto = {
  blob: new Blob([new Uint8Array(10)], { type: "image/jpeg" }),
  width: 1600,
  height: 900,
  capturedAt: "2026-11-24T08:00:00.000Z",
  location: { latitude: -26.2, longitude: 28.04, accuracyM: 10 },
  capturedOffline: false,
};
const slot = (over = {}) => ({
  slotId: "slot-1",
  uploadUrl: "https://upload",
  alreadyUploaded: false,
  alreadyRegistered: false,
  evidenceFileId: null,
  ...over,
});
function api(over: Partial<PhotoApi> = {}): PhotoApi {
  return {
    requestSlot: vi.fn(async () => ({ ok: true as const, slot: slot() })),
    put: vi.fn(async () => true),
    register: vi.fn(async () => ({
      ok: true as const,
      evidence: { evidenceFileId: "file-1" },
    })),
    attach: vi.fn(async () => ({ ok: true, message: "Photo attached." })),
    ...over,
  };
}
const ctx = { inspectionId: "insp-1", deviceKey: "key-1" };
let n = 0;
const ids = () => `id-${++n}`;

describe("sendPhoto", () => {
  it("runs slot -> upload -> register -> attach with the capture context and the right target", async () => {
    const a = api();
    const p = newPendingPhoto(
      photo,
      { kind: "defect", templateItemId: "item-1" },
      ids,
    );
    expect(await sendPhoto(p, ctx, a)).toEqual({ ok: true });
    expect(a.requestSlot).toHaveBeenCalledWith({
      inspectionId: "insp-1",
      kind: "defect",
      sizeBytes: 10,
      deviceCaptureAt: photo.capturedAt,
      location: photo.location,
      capturedOffline: false,
      deviceKey: "key-1",
      clientSubmissionId: p.slotSubmissionId,
    });
    expect(a.put).toHaveBeenCalledWith("https://upload", photo.blob);
    expect(a.register).toHaveBeenCalledWith("slot-1");
    expect(a.attach).toHaveBeenCalledWith({
      inspectionId: "insp-1",
      evidenceFileId: "file-1",
      templateItemId: "item-1",
      kind: "defect",
      clientSubmissionId: p.attachSubmissionId,
    });
  });

  it("uses a different client_submission_id for the slot and for the attach", () => {
    const p = newPendingPhoto(photo, { kind: "odometer" });
    expect(p.slotSubmissionId).not.toBe(p.attachSubmissionId);
  });

  it("network failure while uploading: 'not sent', retryable, and a retry reuses the SAME ids (no duplicates)", async () => {
    const put = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const a = api({ put });
    const p = newPendingPhoto(photo, { kind: "odometer" }, ids);
    const first = await sendPhoto(p, ctx, a);
    expect(first).toMatchObject({ ok: false, retry: true });
    expect(a.register).not.toHaveBeenCalled();
    expect(a.attach).not.toHaveBeenCalled();
    const second = await sendPhoto(p, ctx, a);
    expect(second).toEqual({ ok: true });
    const slotIds = vi
      .mocked(a.requestSlot)
      .mock.calls.map((c) => c[0].clientSubmissionId);
    expect(new Set(slotIds).size).toBe(1);
    expect(vi.mocked(a.attach).mock.calls).toHaveLength(1);
  });

  it("a thrown call (no connection) is retryable", async () => {
    const a = api({
      requestSlot: vi.fn(async () => {
        throw new Error("offline");
      }),
    });
    const r = await sendPhoto(
      newPendingPhoto(photo, { kind: "odometer" }),
      ctx,
      a,
    );
    expect(r).toMatchObject({ ok: false, retry: true });
  });

  it("a retry after the upload already happened goes straight to register", async () => {
    const a = api({
      requestSlot: vi.fn(async () => ({
        ok: true as const,
        slot: slot({ uploadUrl: null, alreadyUploaded: true }),
      })),
    });
    expect(
      await sendPhoto(newPendingPhoto(photo, { kind: "odometer" }), ctx, a),
    ).toEqual({ ok: true });
    expect(a.put).not.toHaveBeenCalled();
    expect(a.register).toHaveBeenCalledOnce();
  });

  it("a retry after the file was registered only attaches (the attach is idempotent per its own id)", async () => {
    const a = api({
      requestSlot: vi.fn(async () => ({
        ok: true as const,
        slot: slot({
          uploadUrl: null,
          alreadyUploaded: true,
          alreadyRegistered: true,
          evidenceFileId: "file-9",
        }),
      })),
    });
    expect(
      await sendPhoto(newPendingPhoto(photo, { kind: "odometer" }), ctx, a),
    ).toEqual({ ok: true });
    expect(a.register).not.toHaveBeenCalled();
    expect(vi.mocked(a.attach).mock.calls[0]![0].evidenceFileId).toBe("file-9");
  });

  it("the server's refusal is shown as is and is not offered as a retry", async () => {
    const a = api({
      attach: vi.fn(async () => ({
        ok: false,
        message:
          "Photos for an inspection must be taken with the in-app camera.",
      })),
    });
    const r = await sendPhoto(
      newPendingPhoto(photo, { kind: "odometer" }),
      ctx,
      a,
    );
    expect(r).toEqual({
      ok: false,
      message: "Photos for an inspection must be taken with the in-app camera.",
      retry: false,
    });
  });

  it("a slot refusal (e.g. no permission) is not retryable", async () => {
    const a = api({
      requestSlot: vi.fn(async () => ({
        ok: false as const,
        message: "You are not allowed to do this.",
      })),
    });
    const r = await sendPhoto(
      newPendingPhoto(photo, { kind: "odometer" }),
      ctx,
      a,
    );
    expect(r).toEqual({
      ok: false,
      message: "You are not allowed to do this.",
      retry: false,
    });
  });
});
