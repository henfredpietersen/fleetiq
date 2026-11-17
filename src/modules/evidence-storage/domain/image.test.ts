import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { bytes, jpeg, png, tiff } from "./fixtures";
import { readDimensions, sha256Hex, sniffMime } from "./image";

describe("sniffMime — type comes from the bytes, not from the client", () => {
  it("detects JPEG and PNG", () => {
    expect(sniffMime(jpeg({}))).toBe("image/jpeg");
    expect(sniffMime(png({}))).toBe("image/png");
  });
  it("rejects everything else, whatever it claims to be", () => {
    expect(sniffMime(bytes("%PDF-1.7 ..."))).toBeNull();
    expect(sniffMime(bytes("GIF89a......"))).toBeNull();
    expect(sniffMime(bytes("<html><script>alert(1)</script>"))).toBeNull();
    expect(sniffMime(new Uint8Array())).toBeNull();
    expect(sniffMime(Uint8Array.from([0xff, 0xd8]))).toBeNull(); // too short
  });
});

describe("readDimensions", () => {
  it("reads JPEG SOF and PNG IHDR", () => {
    expect(
      readDimensions(jpeg({ exif: tiff({ le: true }) }), "image/jpeg"),
    ).toEqual({ width: 640, height: 480 });
    expect(readDimensions(png({}), "image/png")).toEqual({
      width: 256,
      height: 200,
    });
  });
  it("returns null when there is no header to read", () => {
    expect(
      readDimensions(bytes([0xff, 0xd8, 0xff, 0xd9]), "image/jpeg"),
    ).toBeNull();
    expect(readDimensions(bytes("short"), "image/png")).toBeNull();
  });
});

describe("sha256Hex", () => {
  it("is the real SHA-256 (computed by the server over the stored bytes)", () => {
    const data = jpeg({});
    expect(sha256Hex(data)).toBe(
      createHash("sha256").update(data).digest("hex"),
    );
    expect(sha256Hex(bytes("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
