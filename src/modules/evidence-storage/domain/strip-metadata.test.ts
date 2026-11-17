import { describe, expect, it } from "vitest";
import {
  contains,
  DHT,
  DQT,
  ENTROPY_1,
  ENTROPY_2,
  GPS_LAT,
  jpeg,
  png,
  SOF0,
  SOS,
  THUMB,
  tiff,
} from "./fixtures";
import {
  MetadataError,
  stripJpegMetadata,
  stripMetadata,
  stripPngMetadata,
} from "./strip-metadata";

/** Minimal Exif reader for the assertions: returns IFD0 tag ids + next-IFD pointer of the first Exif segment, or null. */
function readExif(jpg: Uint8Array) {
  let i = 2;
  while (i + 4 < jpg.length) {
    const marker = jpg[i + 1]!;
    const len = (jpg[i + 2]! << 8) | jpg[i + 3]!;
    if (marker === 0xe1 && contains(jpg.subarray(i + 4, i + 10), "Exif\0\0")) {
      const t = jpg.subarray(i + 10, i + 2 + len);
      const le = t[0] === 0x49;
      const dv = new DataView(t.buffer, t.byteOffset, t.byteLength);
      const ifd0 = dv.getUint32(4, le);
      const n = dv.getUint16(ifd0, le);
      const tags = Array.from({ length: n }, (_, k) =>
        dv.getUint16(ifd0 + 2 + k * 12, le),
      );
      const next = dv.getUint32(ifd0 + 2 + n * 12, le);
      const orientation = tags.includes(0x0112)
        ? dv.getUint16(ifd0 + 2 + tags.indexOf(0x0112) * 12 + 8, le)
        : null;
      return { tags, next, orientation, size: t.length };
    }
    if (marker === 0xda) break;
    i += 2 + len;
  }
  return null;
}

describe.each([
  ["little-endian", true],
  ["big-endian", false],
])("JPEG GPS stripping (%s Exif)", (_n, le) => {
  const input = jpeg({
    exif: tiff({ le, thumb: true }),
    xmp: true,
    comment: true,
    trailer: true,
  });
  const out = stripJpegMetadata(input);

  it("removes the GPS IFD, its coordinates and the thumbnail, but keeps other Exif (Orientation)", () => {
    const exif = readExif(out)!;
    expect(exif.tags).toEqual([0x0112]); // GPS pointer gone
    expect(exif.orientation).toBe(6);
    expect(exif.next).toBe(0); // thumbnail chain cut
    expect(contains(out, GPS_LAT)).toBe(false);
    expect(contains(out, THUMB)).toBe(false);
  });

  it("drops XMP, comments and bytes after EOI", () => {
    expect(contains(out, "GPSLatitude")).toBe(false);
    expect(contains(out, "xmpmeta")).toBe(false);
    expect(contains(out, "SECRET-COMMENT")).toBe(false);
    expect(contains(out, "TRAILER-WITH-GPS")).toBe(false);
    expect([...out.subarray(-2)]).toEqual([0xff, 0xd9]);
  });

  it("keeps the image data and tables byte-for-byte", () => {
    for (const part of [DQT, SOF0, DHT, SOS, Uint8Array.from(ENTROPY_1)]) {
      expect(contains(out, [...part])).toBe(true);
    }
  });

  it("is idempotent and reports whether anything changed", () => {
    expect(stripJpegMetadata(out)).toEqual(out);
    expect(stripMetadata(input, "image/jpeg").changed).toBe(true);
    expect(stripMetadata(out, "image/jpeg").changed).toBe(false);
  });
});

describe("JPEG stripping — other cases", () => {
  it("never mutates the caller's buffer", () => {
    const input = jpeg({ exif: tiff({ le: true }) });
    const copy = input.slice();
    stripJpegMetadata(input);
    expect(input).toEqual(copy);
  });

  it("a JPEG without Exif passes through unchanged", () => {
    const clean = jpeg({});
    expect(stripJpegMetadata(clean)).toEqual(clean);
  });

  it("handles multi-scan (progressive) files: later tables and scans are kept", () => {
    const out = stripJpegMetadata(
      jpeg({ exif: tiff({ le: true }), progressive: true }),
    );
    expect(contains(out, ENTROPY_2)).toBe(true);
    expect(contains(out, [...DHT, ...SOS, ...ENTROPY_2])).toBe(true);
  });

  it("fails closed: Exif that cannot be parsed safely is dropped whole, never copied through", () => {
    const out = stripJpegMetadata(
      jpeg({ exif: tiff({ le: true, badGps: true }) }),
    );
    expect(readExif(out)).toBeNull();
    expect(contains(out, "Exif")).toBe(false);
    expect(contains(out, GPS_LAT)).toBe(false);
    expect(contains(out, [...SOF0])).toBe(true); // the picture itself is intact
  });

  it("rejects things that are not complete JPEGs", () => {
    expect(() => stripJpegMetadata(Uint8Array.from([1, 2, 3, 4, 5]))).toThrow(
      MetadataError,
    );
    const whole = jpeg({});
    expect(() =>
      stripJpegMetadata(whole.subarray(0, whole.length - 2)),
    ).toThrow(MetadataError); // no EOI
    expect(() => stripJpegMetadata(whole.subarray(0, 30))).toThrow(
      MetadataError,
    ); // cut mid-segment
  });
});

describe("PNG metadata stripping", () => {
  const out = stripPngMetadata(png({ meta: true, trailer: true }));
  it("drops eXIf, text, time, unknown chunks and trailing bytes", () => {
    for (const s of [
      "eXIf",
      "tEXt",
      "tIME",
      "prVt",
      "GPS-IN-EXIF",
      "28.05",
      "TRAILER",
    ]) {
      expect(contains(out, s)).toBe(false);
    }
  });
  it("keeps the image chunks", () => {
    for (const s of ["IHDR", "pHYs", "IDAT", "IEND"])
      expect(contains(out, s)).toBe(true);
  });
  it("is idempotent; clean PNGs are unchanged", () => {
    expect(stripPngMetadata(out)).toEqual(out);
    const clean = png({});
    expect(stripMetadata(clean, "image/png").changed).toBe(false);
  });
  it("rejects truncated or non-PNG input", () => {
    const whole = png({});
    expect(() => stripPngMetadata(whole.subarray(0, whole.length - 5))).toThrow(
      MetadataError,
    );
    expect(() => stripPngMetadata(Uint8Array.from([0, 1, 2]))).toThrow(
      MetadataError,
    );
  });
});
