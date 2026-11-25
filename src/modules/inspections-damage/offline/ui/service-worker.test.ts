// The service worker's caching rules (public/sw.js): what may be cached, and — more important — what never is.
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const src = readFileSync(
  path.resolve(__dirname, "../../../../../public/sw.js"),
  "utf8",
);
type Classify = (
  u: URL,
  m: string,
  mode: string,
  h: Headers,
  o: string,
) => string;
const sandbox = {
  self: {
    addEventListener() {},
    location: { origin: "https://fleet.test" },
  } as Record<string, unknown>,
  URL,
  Headers,
};
vm.runInNewContext(src, sandbox);
const classify = (sandbox.self.fleetiqSw as { classify: Classify }).classify;
const O = "https://fleet.test";
const c = (
  p: string,
  o: {
    method?: string;
    mode?: string;
    headers?: Record<string, string>;
    origin?: string;
  } = {},
) =>
  classify(
    new URL(p, o.origin ?? O),
    o.method ?? "GET",
    o.mode ?? "no-cors",
    new Headers(o.headers),
    O,
  );

describe("service worker caching rules", () => {
  it("caches only the app's static build output and the offline shell", () => {
    expect(c("/_next/static/chunks/app-1234.js")).toBe("static");
    expect(c("/_next/static/css/app.css")).toBe("static");
    expect(c("/offline", { mode: "navigate" })).toBe("shell");
    expect(c("/offline?next=%2Fmy-allocations")).toBe("shell");
    expect(c("/favicon.ico")).toBe("static");
  });
  it("never caches API responses (the queue endpoint, the snapshot, anything with a person's data)", () => {
    expect(c("/api/inspection-sync")).toBe("never");
    expect(c("/api/anything/else")).toBe("never");
    expect(c("/api/inspection-sync", { method: "POST" })).toBe("never");
  });
  it("never caches React Server Component payloads or prefetches", () => {
    expect(c("/my-allocations?_rsc=abc")).toBe("never");
    expect(c("/my-allocations", { headers: { RSC: "1" } })).toBe("never");
    expect(
      c("/my-allocations", { headers: { "Next-Router-State-Tree": "x" } }),
    ).toBe("never");
    expect(
      c("/my-allocations", { headers: { "Next-Router-Prefetch": "1" } }),
    ).toBe("never");
  });
  it("never caches signed photo URLs or anything cross-origin (the storage host)", () => {
    expect(
      c("/storage/v1/object/sign/evidence/x.jpg?token=t", {
        origin: "http://127.0.0.1:54321",
      }),
    ).toBe("never");
    expect(
      c("https://storage.example/object/upload/sign/evidence/x?token=t", {
        method: "PUT",
      }),
    ).toBe("never");
  });
  it("never caches non-GET requests (server actions, uploads)", () => {
    expect(c("/my-allocations", { method: "POST", mode: "navigate" })).toBe(
      "never",
    );
  });
  it("a normal page navigation is handled only to fall back to the offline shell; its HTML is never stored", () => {
    expect(
      c("/my-allocations/abc/inspection/pre-shift", { mode: "navigate" }),
    ).toBe("navigation");
    const opened = [...src.matchAll(/caches\.open\((\w+)\)/g)].map((m) => m[1]);
    expect(opened.length).toBeGreaterThan(0);
    expect(
      opened.every((n) => n === "STATIC_CACHE" || n === "SHELL_CACHE"),
    ).toBe(true); // no other cache exists
    // the navigation branch never stores a response
    const nav = src.slice(
      src.indexOf('kind === "navigation"'),
      src.indexOf("// anything else"),
    );
    expect(nav).not.toMatch(/\.put\(/);
  });
  it("fetches that are neither static nor navigations are left alone", () => {
    expect(c("/sign-in.json")).toBe("never");
  });
});
