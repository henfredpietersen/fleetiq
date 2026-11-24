import { describe, expect, it } from "vitest";
import {
  deviceShortCode,
  isDeviceKey,
  parseDeviceKeyInput,
} from "./device-key";

const K = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
describe("device key helpers", () => {
  it("recognises a UUID and nothing else", () => {
    expect(isDeviceKey(K)).toBe(true);
    for (const v of ["", "abc", null, undefined, 12, K + "x"])
      expect(isDeviceKey(v)).toBe(false);
  });
  it("shows a short code of the first eight characters", () => {
    expect(deviceShortCode(K)).toBe("0A1B-2C3D");
  });
  it("accepts the key as typed: with or without dashes, any case, spaces around", () => {
    expect(parseDeviceKeyInput(` ${K.toUpperCase()} `)).toBe(K);
    expect(parseDeviceKeyInput(K.replace(/-/g, ""))).toBe(K);
    expect(parseDeviceKeyInput("0a1b-2c3d")).toBeNull();
    expect(parseDeviceKeyInput("not a key")).toBeNull();
  });
});
