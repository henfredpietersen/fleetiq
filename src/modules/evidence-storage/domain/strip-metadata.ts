// DEC-29 (Proposed, flag default ON): the stored evidence file must not carry GPS location.
//
// JPEG: rebuilt from a WHITELIST of segments. Kept: image data/tables, JFIF (APP0), ICC profile (APP2),
//   Adobe colour flag (APP14) and the Exif segment AFTER its GPS IFD (and any embedded thumbnail) has been
//   removed/zeroed — the rest of Exif, e.g. Orientation, is preserved. Dropped: XMP (can carry GPS), IPTC/
//   Photoshop, MPF, comments, every other APPn, and any bytes after EOI.
// PNG: ancillary chunks that can carry metadata (eXIf, tEXt, zTXt, iTXt, tIME) and unknown chunks are dropped.
// Exif that cannot be parsed with certainty is dropped whole (fail closed), never copied through.
//
// Known limit: vendor-specific MakerNote blobs are opaque and are not inspected.

export class MetadataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetadataError";
  }
}

const concat = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

const startsWith = (b: Uint8Array, text: string): boolean =>
  b.length >= text.length &&
  [...text].every((ch, i) => b[i] === ch.charCodeAt(0));

// ------------------------------------------------------------------ Exif / TIFF
const TYPE_SIZE: Record<number, number> = {
  1: 1,
  2: 1,
  3: 2,
  4: 4,
  5: 8,
  6: 1,
  7: 1,
  8: 2,
  9: 4,
  10: 8,
  11: 4,
  12: 8,
};

/** Removes the GPS IFD (and any thumbnail) from a TIFF block IN PLACE. Returns false if it cannot be parsed safely. */
function sanitizeTiff(t: Uint8Array): boolean {
  if (t.length < 8) return false;
  const le = t[0] === 0x49 && t[1] === 0x49;
  const be = t[0] === 0x4d && t[1] === 0x4d;
  if (!le && !be) return false;
  const dv = new DataView(t.buffer, t.byteOffset, t.byteLength);
  const u16 = (o: number) => dv.getUint16(o, le);
  const u32 = (o: number) => dv.getUint32(o, le);
  const w16 = (o: number, v: number) => dv.setUint16(o, v, le);
  const w32 = (o: number, v: number) => dv.setUint32(o, v, le);
  const len = t.length;
  const inRange = (o: number, n: number) => o >= 8 && n >= 0 && o + n <= len;

  const zero = (o: number, n: number) => {
    if (!inRange(o, n)) throw new MetadataError("exif range");
    t.fill(0, o, o + n);
  };

  /** Zero the GPS IFD at `off`, including out-of-line values. */
  const zeroGpsIfd = (off: number) => {
    if (!inRange(off, 2)) throw new MetadataError("gps ifd");
    const n = u16(off);
    const end = off + 2 + n * 12 + 4;
    if (!inRange(off, end - off)) throw new MetadataError("gps ifd size");
    for (let i = 0; i < n; i++) {
      const e = off + 2 + i * 12;
      const size = (TYPE_SIZE[u16(e + 2)] ?? 1) * u32(e + 4);
      if (size > 4) zero(u32(e + 8), size);
    }
    zero(off, end - off);
  };

  /** Removes the GPS pointer entry from the IFD at `off`; returns the position of its next-IFD pointer. */
  const cleanIfd = (off: number, thumbnail: boolean): number => {
    if (!inRange(off, 2)) throw new MetadataError("ifd");
    let n = u16(off);
    const first = off + 2;
    if (!inRange(off, 2 + n * 12 + 4)) throw new MetadataError("ifd size");
    for (let i = 0; i < n; i++) {
      const e = first + i * 12;
      const tag = u16(e);
      if (thumbnail && (tag === 0x0201 || tag === 0x0202)) {
        // JPEGInterchangeFormat / Length: the embedded thumbnail may carry its own Exif+GPS.
        continue;
      }
      if (tag === 0x8825) {
        zeroGpsIfd(u32(e + 8));
        const tailStart = e + 12;
        const tailEnd = first + n * 12 + 4; // includes the next-IFD pointer
        t.copyWithin(e, tailStart, tailEnd);
        t.fill(0, tailEnd - 12, tailEnd);
        n -= 1;
        w16(off, n);
        break; // a valid IFD has one GPS pointer
      }
    }
    return first + n * 12;
  };

  try {
    if (u16(2) !== 42) return false;
    const ifd0 = u32(4);
    const next0 = cleanIfd(ifd0, false);
    const ifd1 = u32(next0);
    if (ifd1 !== 0) {
      // Zero the thumbnail bytes, then cut the chain so nothing references IFD1.
      if (!inRange(ifd1, 2)) return false;
      const n1 = u16(ifd1);
      if (!inRange(ifd1, 2 + n1 * 12 + 4)) return false;
      let offset = 0;
      let length = 0;
      for (let i = 0; i < n1; i++) {
        const e = ifd1 + 2 + i * 12;
        const tag = u16(e);
        if (tag === 0x0201) offset = u32(e + 8);
        if (tag === 0x0202) length = u32(e + 8);
      }
      if (offset && length) zero(offset, length);
      cleanIfd(ifd1, true);
      w32(next0, 0);
    }
    return true;
  } catch (e) {
    if (e instanceof MetadataError || e instanceof RangeError) return false;
    throw e;
  }
}

// ------------------------------------------------------------------ JPEG
export function stripJpegMetadata(input: Uint8Array): Uint8Array {
  if (!(input.length > 4 && input[0] === 0xff && input[1] === 0xd8)) {
    throw new MetadataError("not a JPEG");
  }
  const out: Uint8Array[] = [Uint8Array.of(0xff, 0xd8)];
  const len = input.length;
  let i = 2;
  while (i < len) {
    if (input[i] !== 0xff) throw new MetadataError("corrupt JPEG marker");
    while (i < len && input[i] === 0xff) i++; // fill bytes
    const marker = input[i++];
    if (marker === undefined) break;
    if (marker === 0xd9) {
      out.push(Uint8Array.of(0xff, 0xd9)); // EOI — anything after it is dropped
      return concat(out);
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      out.push(Uint8Array.of(0xff, marker));
      continue;
    }
    if (i + 2 > len) throw new MetadataError("truncated JPEG");
    const segLen = (input[i]! << 8) | input[i + 1]!;
    if (segLen < 2 || i + segLen > len)
      throw new MetadataError("truncated JPEG");
    const segment = input.subarray(i, i + segLen); // length bytes + payload
    const payload = segment.subarray(2);

    if (marker === 0xda) {
      // SOS: keep the header and the entropy-coded data up to the next real marker.
      out.push(Uint8Array.of(0xff, marker), segment);
      i += segLen;
      let j = i;
      while (j < len) {
        if (input[j] === 0xff) {
          const nx = input[j + 1];
          if (nx === 0x00 || (nx !== undefined && nx >= 0xd0 && nx <= 0xd7)) {
            j += 2;
            continue;
          }
          if (nx === 0xff) {
            j += 1;
            continue;
          }
          break;
        }
        j++;
      }
      out.push(input.subarray(i, j));
      i = j;
      continue;
    }

    i += segLen;
    const isApp = marker >= 0xe0 && marker <= 0xef;
    if (marker === 0xfe) continue; // comment
    if (!isApp) {
      out.push(Uint8Array.of(0xff, marker), segment);
      continue;
    }
    if (marker === 0xe0 && startsWith(payload, "JFIF\0")) {
      out.push(Uint8Array.of(0xff, marker), segment);
    } else if (marker === 0xe2 && startsWith(payload, "ICC_PROFILE\0")) {
      out.push(Uint8Array.of(0xff, marker), segment);
    } else if (marker === 0xee && startsWith(payload, "Adobe")) {
      out.push(Uint8Array.of(0xff, marker), segment);
    } else if (marker === 0xe1 && startsWith(payload, "Exif\0\0")) {
      const copy = segment.slice(); // never mutate the caller's bytes
      if (sanitizeTiff(copy.subarray(2 + 6))) {
        out.push(Uint8Array.of(0xff, marker), copy);
      } // else: unparseable Exif is dropped whole
    }
    // every other APPn (XMP, IPTC, MPF, vendor) is dropped
  }
  throw new MetadataError("JPEG has no end marker");
}

// ------------------------------------------------------------------ PNG
const PNG_KEEP = new Set([
  "IHDR",
  "PLTE",
  "IDAT",
  "IEND",
  "tRNS",
  "gAMA",
  "cHRM",
  "sRGB",
  "iCCP",
  "sBIT",
  "pHYs",
  "bKGD",
  "hIST",
  "sPLT",
  "acTL",
  "fcTL",
  "fdAT",
  "cICP",
  "mDCV",
  "cLLI",
]);

export function stripPngMetadata(input: Uint8Array): Uint8Array {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (input.length < 8 || !sig.every((v, i) => input[i] === v)) {
    throw new MetadataError("not a PNG");
  }
  const out: Uint8Array[] = [input.subarray(0, 8)];
  const dv = new DataView(input.buffer, input.byteOffset, input.byteLength);
  let i = 8;
  let sawIend = false;
  while (i + 12 <= input.length && !sawIend) {
    const clen = dv.getUint32(i, false);
    const type = String.fromCharCode(...input.subarray(i + 4, i + 8));
    const total = 12 + clen;
    if (i + total > input.length) throw new MetadataError("truncated PNG");
    if (PNG_KEEP.has(type)) out.push(input.subarray(i, i + total));
    if (type === "IEND") sawIend = true;
    i += total;
  }
  if (!sawIend) throw new MetadataError("PNG has no end chunk");
  return concat(out); // bytes after IEND are dropped
}

export type StripResult = { bytes: Uint8Array; changed: boolean };

export function stripMetadata(
  input: Uint8Array,
  mime: "image/jpeg" | "image/png",
): StripResult {
  const bytes =
    mime === "image/jpeg" ? stripJpegMetadata(input) : stripPngMetadata(input);
  const changed =
    bytes.length !== input.length || bytes.some((v, i) => v !== input[i]);
  return { bytes, changed };
}
