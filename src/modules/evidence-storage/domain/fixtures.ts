// Synthetic, structurally valid image bytes for tests (no real photos, no real locations).
export const bytes = (
  ...parts: (number[] | Uint8Array | string)[]
): Uint8Array => {
  const arrs = parts.map((p) =>
    typeof p === "string"
      ? Uint8Array.from([...p].map((c) => c.charCodeAt(0)))
      : Uint8Array.from(p),
  );
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrs) {
    out.set(a, o);
    o += a.length;
  }
  return out;
};

/** Marker bytes that must never survive stripping. */
export const GPS_LAT = [0xab, 0xcd, 0xef, 0x01, 0x23, 0x45, 0x67, 0x89];
export const THUMB = "THUMBNAIL-WITH-GPS";

/** Exif TIFF block: IFD0 {Orientation=6, GPS pointer} -> GPS IFD -> optional IFD1 thumbnail. */
export function tiff(opts: {
  le: boolean;
  thumb?: boolean;
  badGps?: boolean;
}): Uint8Array {
  const { le } = opts;
  const buf: number[] = [];
  const u16 = (v: number) => (le ? [v & 255, v >> 8] : [v >> 8, v & 255]);
  const u32 = (v: number) =>
    le
      ? [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255]
      : [(v >>> 24) & 255, (v >> 16) & 255, (v >> 8) & 255, v & 255];
  const entry = (tag: number, type: number, count: number, value: number[]) => [
    ...u16(tag),
    ...u16(type),
    ...u32(count),
    ...value,
  ];
  const IFD0 = 8;
  const GPS = 38; // IFD0 = 2 + 2*12 + 4 = 30 bytes
  const GPS_VALUES = GPS + 30; // GPS IFD = 30 bytes
  const IFD1 = GPS_VALUES + 24;
  const THUMB_AT = IFD1 + 30;
  buf.push(...(le ? [0x49, 0x49] : [0x4d, 0x4d]), ...u16(42), ...u32(IFD0));
  // IFD0
  buf.push(...u16(2));
  buf.push(...entry(0x0112, 3, 1, [...u16(6), 0, 0]));
  buf.push(...entry(0x8825, 4, 1, u32(opts.badGps ? 999999 : GPS)));
  buf.push(...u32(opts.thumb ? IFD1 : 0));
  // GPS IFD: latitude ref (inline) + latitude (3 rationals, out of line)
  buf.push(...u16(2));
  buf.push(...entry(0x0001, 2, 2, [0x53, 0, 0, 0])); // "S"
  buf.push(...entry(0x0002, 5, 3, u32(GPS_VALUES)));
  buf.push(...u32(0));
  buf.push(...GPS_LAT, ...new Array(16).fill(0x77)); // 24 bytes of "coordinates"
  if (opts.thumb) {
    buf.push(...u16(2));
    buf.push(...entry(0x0201, 4, 1, u32(THUMB_AT)));
    buf.push(...entry(0x0202, 4, 1, u32(THUMB.length)));
    buf.push(...u32(0));
    buf.push(...[...THUMB].map((c) => c.charCodeAt(0)));
  }
  return Uint8Array.from(buf);
}

export const seg = (
  marker: number,
  payload: Uint8Array | number[] | string,
) => {
  const p =
    typeof payload === "string" ? bytes(payload) : Uint8Array.from(payload);
  const len = p.length + 2;
  return bytes([0xff, marker, len >> 8, len & 255], p);
};

export const ENTROPY_1 = [0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56];
export const ENTROPY_2 = [0x9a, 0xff, 0x00, 0xbc];
export const DQT = seg(0xdb, new Array(65).fill(3));
export const SOF0 = seg(0xc0, [8, 0x01, 0xe0, 0x02, 0x80, 1, 1, 0x11, 0]); // 640 x 480
export const DHT = seg(0xc4, new Array(20).fill(1));
export const SOS = seg(0xda, [1, 1, 0, 0, 63, 0]);

export function jpeg(opts: {
  exif?: Uint8Array;
  xmp?: boolean;
  comment?: boolean;
  trailer?: boolean;
  progressive?: boolean;
}): Uint8Array {
  return bytes(
    [0xff, 0xd8],
    seg(0xe0, "JFIF\0\x01\x01\0\0\x01\0\x01\0\0"),
    opts.exif ? seg(0xe1, bytes("Exif\0\0", opts.exif)) : [],
    opts.xmp
      ? seg(
          0xe1,
          "http://ns.adobe.com/xap/1.0/\0<x:xmpmeta exif:GPSLatitude='26,12.5S'/>",
        )
      : [],
    opts.comment ? seg(0xfe, "SECRET-COMMENT") : [],
    DQT,
    SOF0,
    DHT,
    SOS,
    ENTROPY_1,
    ...(opts.progressive ? [DHT, SOS, ENTROPY_2] : []),
    [0xff, 0xd9],
    opts.trailer ? "TRAILER-WITH-GPS" : "",
  );
}

export const contains = (
  hay: Uint8Array,
  needle: number[] | string,
): boolean => {
  const n =
    typeof needle === "string"
      ? [...needle].map((c) => c.charCodeAt(0))
      : needle;
  outer: for (let i = 0; i + n.length <= hay.length; i++) {
    for (let j = 0; j < n.length; j++) if (hay[i + j] !== n[j]) continue outer;
    return true;
  }
  return false;
};

// PNG
const chunk = (type: string, data: number[] | string) => {
  const d =
    typeof data === "string" ? [...data].map((c) => c.charCodeAt(0)) : data;
  return bytes(
    [
      (d.length >>> 24) & 255,
      (d.length >> 16) & 255,
      (d.length >> 8) & 255,
      d.length & 255,
    ],
    type,
    d,
    [1, 2, 3, 4], // CRC is copied, not recomputed
  );
};
export function png(opts: { meta?: boolean; trailer?: boolean }): Uint8Array {
  return bytes(
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    chunk("IHDR", [0, 0, 1, 0, 0, 0, 0, 0xc8, 8, 2, 0, 0, 0]), // 256 x 200
    opts.meta ? chunk("eXIf", "GPS-IN-EXIF") : [],
    opts.meta ? chunk("tEXt", "Location\0-26.2,28.05") : [],
    opts.meta ? chunk("tIME", [7, 234, 11, 17, 9, 0, 0]) : [],
    opts.meta ? chunk("prVt", "PRIVATE-UNKNOWN") : [],
    chunk("pHYs", [0, 0, 11, 19, 0, 0, 11, 19, 1]),
    chunk("IDAT", [9, 9, 9, 9]),
    chunk("IEND", []),
    opts.trailer ? "TRAILER-WITH-GPS" : "",
  );
}
