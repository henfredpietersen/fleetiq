import { describe, expect, it } from "vitest";
import {
  backoffMs,
  classifyHttp,
  classifyNetworkError,
  classifyPut,
} from "./classify";

describe("error classification (DEC-06): retry vs conflict", () => {
  it("a network failure or timeout is a retry, never a refusal", () => {
    expect(classifyNetworkError().kind).toBe("retry");
  });
  it("5xx, 408, 425 and 429 are retries", () => {
    for (const s of [500, 502, 503, 504, 408, 425, 429])
      expect(classifyHttp(s, { ok: false, message: "x" }).kind).toBe("retry");
  });
  it("a 2xx that is not our JSON (a captive portal page) is a retry", () => {
    expect(classifyHttp(200, null).kind).toBe("retry");
    expect(classifyHttp(200, { ok: false }).kind).toBe("retry");
  });
  it("401 pauses the queue until the next sign-in", () => {
    expect(classifyHttp(401, { message: "expired" }).kind).toBe("auth");
  });
  it("a server refusal is a conflict, with the server's code and message as they are", () => {
    for (const [status, code] of [
      [403, "42501"],
      [404, "P0002"],
      [409, "55000"],
      [409, "22023"],
      [422, "IN006"],
    ] as const) {
      expect(
        classifyHttp(status, {
          ok: false,
          code,
          message: "This allocation was cancelled.",
        }),
      ).toEqual({
        kind: "refused",
        code,
        message: "This allocation was cancelled.",
        status,
      });
    }
  });
  it("a refusal without a body still names the HTTP status", () => {
    expect(classifyHttp(403, null)).toMatchObject({
      kind: "refused",
      code: "HTTP 403",
    });
  });
  it("a 2xx with ok:true is success and keeps the data", () => {
    expect(classifyHttp(200, { ok: true, inspectionId: "i1" })).toEqual({
      kind: "ok",
      data: { ok: true, inspectionId: "i1" },
    });
  });
  it("the signed upload URL: expired/invalid -> ask for a new slot; other failures -> retry", () => {
    expect(classifyPut(200)).toBe("ok");
    for (const s of [400, 401, 403, 404])
      expect(classifyPut(s)).toBe("expired");
    for (const s of [500, 503, 408, null]) expect(classifyPut(s)).toBe("retry");
  });
});

describe("exponential backoff", () => {
  const cfg = { baseMs: 2_000, factor: 2, maxMs: 60_000 };
  it("doubles each attempt and is capped", () => {
    expect([1, 2, 3, 4, 5, 6, 7].map((n) => backoffMs(n, cfg))).toEqual([
      2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000,
    ]);
  });
  it("never goes below the base", () => {
    expect(backoffMs(0, cfg)).toBe(2_000);
  });
});
