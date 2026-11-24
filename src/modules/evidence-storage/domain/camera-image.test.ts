import { describe, expect, it } from "vitest";
import { CAMERA_CAPTURE } from "./evidence-config";
import { encodeJpeg, fitLongEdge, type CanvasLike } from "./camera-image";

describe("fitLongEdge", () => {
  it("sizes the long edge to the configured value and keeps the aspect ratio", () => {
    expect(CAMERA_CAPTURE.longEdgePx).toBe(1600);
    expect(fitLongEdge({ width: 4000, height: 3000 })).toEqual({
      width: 1600,
      height: 1200,
    });
    expect(fitLongEdge({ width: 3000, height: 4000 })).toEqual({
      width: 1200,
      height: 1600,
    });
    expect(fitLongEdge({ width: 1920, height: 1080 })).toEqual({
      width: 1600,
      height: 900,
    });
    expect(fitLongEdge({ width: 1080, height: 1920 })).toEqual({
      width: 900,
      height: 1600,
    });
  });
  it("never enlarges a smaller frame", () => {
    expect(fitLongEdge({ width: 1280, height: 720 })).toEqual({
      width: 1280,
      height: 720,
    });
    expect(fitLongEdge({ width: 1600, height: 1200 })).toEqual({
      width: 1600,
      height: 1200,
    });
  });
  it("uses the long edge it is given, and keeps whole pixels", () => {
    const r = fitLongEdge({ width: 4032, height: 3024 }, 1000);
    expect(r).toEqual({ width: 1000, height: 750 });
    const odd = fitLongEdge({ width: 3001, height: 2999 }, 1600);
    expect(Math.max(odd.width, odd.height)).toBe(1600);
    expect(Number.isInteger(odd.width) && Number.isInteger(odd.height)).toBe(
      true,
    );
    expect(Math.abs(odd.width / odd.height - 3001 / 2999)).toBeLessThan(0.002);
  });
  it("refuses an empty frame", () => {
    expect(() => fitLongEdge({ width: 0, height: 100 })).toThrow();
  });
});

describe("encodeJpeg", () => {
  function fakeCanvas() {
    const drawn: unknown[][] = [];
    const encode: { type?: string; quality?: number } = {};
    const canvas: CanvasLike = {
      width: 0,
      height: 0,
      getContext: () => ({
        drawImage: (...a: unknown[]) => void drawn.push(a),
      }),
      toBlob: (cb, type, quality) => {
        encode.type = type;
        encode.quality = quality;
        cb(new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type }));
      },
    };
    return { canvas, drawn, encode };
  }
  it("draws the frame at the fitted size and encodes a JPEG at the configured quality", async () => {
    const f = fakeCanvas();
    const frame = { video: true };
    const r = await encodeJpeg(
      frame,
      { width: 1920, height: 1080 },
      () => f.canvas,
    );
    expect(r.width).toBe(1600);
    expect(r.height).toBe(900);
    expect(f.canvas.width).toBe(1600);
    expect(f.canvas.height).toBe(900);
    expect(f.drawn).toEqual([[frame, 0, 0, 1600, 900]]);
    expect(f.encode).toEqual({ type: "image/jpeg", quality: 0.85 });
    expect(r.blob.type).toBe("image/jpeg");
  });
  it("fails clearly when the browser cannot encode", async () => {
    const f = fakeCanvas();
    f.canvas.toBlob = (cb) => cb(null);
    await expect(
      encodeJpeg({}, { width: 10, height: 10 }, () => f.canvas),
    ).rejects.toThrow(/encode/);
  });
  it("fails clearly without a 2d canvas", async () => {
    const f = fakeCanvas();
    f.canvas.getContext = () => null;
    await expect(
      encodeJpeg({}, { width: 10, height: 10 }, () => f.canvas),
    ).rejects.toThrow(/canvas/);
  });
});
