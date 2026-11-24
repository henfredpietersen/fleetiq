import { describe, expect, it, vi } from "vitest";
import {
  newPendingDamagePhoto,
  sendDamagePhoto,
  type DamagePhotoApi,
} from "./damage-photo-upload";

const photo = {
  blob: new Blob(["x"]),
  width: 10,
  height: 10,
  capturedAt: "2026-11-24T08:00:00.000Z",
  location: null,
  capturedOffline: false,
};
const slot = (o: object = {}) => ({
  slotId: "s1",
  uploadUrl: "https://u",
  alreadyUploaded: false,
  alreadyRegistered: false,
  evidenceFileId: null,
  ...o,
});
function api(over: Partial<DamagePhotoApi> = {}): DamagePhotoApi {
  return {
    requestSlot: vi.fn(async () => ({ ok: true as const, slot: slot() })),
    put: vi.fn(async () => true),
    register: vi.fn(async () => ({
      ok: true as const,
      evidence: { evidenceFileId: "f1" },
    })),
    ...over,
  };
}
const ctx = { inspectionId: "i1", deviceKey: null };

describe("sendDamagePhoto", () => {
  it("requests a slot, uploads, registers and returns the evidence file id", async () => {
    const a = api();
    const p = newPendingDamagePhoto(photo, () => "sub1");
    expect(await sendDamagePhoto(p, ctx, a)).toEqual({
      ok: true,
      evidenceFileId: "f1",
    });
    expect(a.requestSlot).toHaveBeenCalledWith(
      expect.objectContaining({
        inspectionId: "i1",
        clientSubmissionId: "sub1",
      }),
    );
    expect(a.put).toHaveBeenCalledOnce();
  });
  it("a failed upload is retryable and a retry reuses the same slot submission id", async () => {
    const put = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const a = api({ put });
    const p = newPendingDamagePhoto(photo, () => "sub1");
    const first = await sendDamagePhoto(p, ctx, a);
    expect(first).toMatchObject({ ok: false, retry: true });
    expect(await sendDamagePhoto(p, ctx, a)).toEqual({
      ok: true,
      evidenceFileId: "f1",
    });
    expect(
      (a.requestSlot as ReturnType<typeof vi.fn>).mock.calls.map(
        (c) => c[0].clientSubmissionId,
      ),
    ).toEqual(["sub1", "sub1"]);
  });
  it("a thrown call (no connection) is retryable", async () => {
    const a = api({
      requestSlot: vi.fn(async () => {
        throw new Error("offline");
      }),
    });
    expect(
      await sendDamagePhoto(newPendingDamagePhoto(photo), ctx, a),
    ).toMatchObject({ ok: false, retry: true });
  });
  it("a refused slot shows the server's message and is not retried", async () => {
    const a = api({
      requestSlot: vi.fn(async () => ({
        ok: false as const,
        message: "Not allowed",
      })),
    });
    expect(await sendDamagePhoto(newPendingDamagePhoto(photo), ctx, a)).toEqual(
      { ok: false, message: "Not allowed", retry: false },
    );
  });
  it("an already registered slot skips the upload", async () => {
    const a = api({
      requestSlot: vi.fn(async () => ({
        ok: true as const,
        slot: slot({ alreadyRegistered: true, evidenceFileId: "f9" }),
      })),
    });
    expect(await sendDamagePhoto(newPendingDamagePhoto(photo), ctx, a)).toEqual(
      { ok: true, evidenceFileId: "f9" },
    );
    expect(a.put).not.toHaveBeenCalled();
  });
  it("a photo that is already registered is not sent again", async () => {
    const a = api();
    const p = { ...newPendingDamagePhoto(photo), evidenceFileId: "f2" };
    expect(await sendDamagePhoto(p, ctx, a)).toEqual({
      ok: true,
      evidenceFileId: "f2",
    });
    expect(a.requestSlot).not.toHaveBeenCalled();
  });
});
