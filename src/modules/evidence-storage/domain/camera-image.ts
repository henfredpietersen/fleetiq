// In-app camera image sizing and encoding (DEC-07, AD-07). Pure apart from the injected canvas, so the numbers are tested
// without a browser. The long edge becomes `longEdgePx` (a smaller frame is never enlarged), the aspect ratio is kept, and the
// result is a JPEG at `jpegQuality`. The original is whatever this produces: it is never altered after upload (DEC-07).
import { CAMERA_CAPTURE } from "./evidence-config";

export type Size = { width: number; height: number };

/** Fit a frame so its long edge is at most `longEdge`; never enlarges; keeps the aspect ratio; whole pixels, at least 1. */
export function fitLongEdge(
  src: Size,
  longEdge: number = CAMERA_CAPTURE.longEdgePx,
): Size {
  const { width, height } = src;
  if (!(width > 0) || !(height > 0)) throw new Error("empty frame");
  const long = Math.max(width, height);
  if (long <= longEdge)
    return { width: Math.round(width), height: Math.round(height) };
  const k = longEdge / long;
  return {
    width: Math.max(1, Math.round(width * k)),
    height: Math.max(1, Math.round(height * k)),
  };
}

export type CanvasLike = {
  width: number;
  height: number;
  getContext(kind: "2d"): {
    drawImage(
      src: unknown,
      dx: number,
      dy: number,
      dw: number,
      dh: number,
    ): void;
  } | null;
  toBlob(cb: (b: Blob | null) => void, type: string, quality: number): void;
};

export type EncodedPhoto = { blob: Blob; width: number; height: number };

/** Draw `frame` (a video element or image bitmap with its pixel size) to a canvas and encode it as JPEG. */
export function encodeJpeg(
  frame: unknown,
  frameSize: Size,
  makeCanvas: () => CanvasLike,
  cfg: Pick<
    typeof CAMERA_CAPTURE,
    "longEdgePx" | "jpegQuality" | "mimeType"
  > = CAMERA_CAPTURE,
): Promise<EncodedPhoto> {
  const { width, height } = fitLongEdge(frameSize, cfg.longEdgePx);
  const canvas = makeCanvas();
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.reject(new Error("canvas unavailable"));
  ctx.drawImage(frame, 0, 0, width, height);
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob && blob.size > 0
          ? resolve({ blob, width, height })
          : reject(new Error("could not encode the photo")),
      cfg.mimeType,
      cfg.jpegQuality,
    );
  });
}
