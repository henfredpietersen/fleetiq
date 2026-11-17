// Server-side image facts. The client's declared type is never trusted: the type comes from the bytes.
import { createHash } from "node:crypto";
import type { SupportedMime } from "./evidence-config";

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Magic-byte detection. Returns null for anything that is not a JPEG or PNG. */
export function sniffMime(b: Uint8Array): SupportedMime | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return "image/jpeg";
  }
  if (b.length >= 8 && PNG_SIG.every((v, i) => b[i] === v)) return "image/png";
  return null;
}

export type Dimensions = { width: number; height: number };

const be16 = (b: Uint8Array, o: number) => (b[o]! << 8) | b[o + 1]!;
const be32 = (b: Uint8Array, o: number) =>
  ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;

/** Width/height from the image header (JPEG SOFn, PNG IHDR); null if not found. */
export function readDimensions(
  b: Uint8Array,
  mime: SupportedMime,
): Dimensions | null {
  if (mime === "image/png") {
    if (
      b.length < 24 ||
      String.fromCharCode(...b.subarray(12, 16)) !== "IHDR"
    ) {
      return null;
    }
    const width = be32(b, 16);
    const height = be32(b, 20);
    return width > 0 && height > 0 ? { width, height } : null;
  }
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    while (i < b.length && b[i] === 0xff) i++;
    const marker = b[i++];
    if (marker === undefined || marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (i + 2 > b.length) return null;
    const len = be16(b, i);
    const isSof =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (isSof) {
      if (len < 8 || i + 7 > b.length) return null;
      const height = be16(b, i + 3);
      const width = be16(b, i + 5);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    i += len;
  }
  return null;
}
