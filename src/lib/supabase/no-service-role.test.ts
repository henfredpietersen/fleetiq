import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "../..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)
      ? [full]
      : [];
  });
}
const rel = (f: string) => path.relative(SRC, f).split(path.sep).join("/");
const files = sourceFiles(SRC);
const read = (f: string) => readFileSync(f, "utf8");

// ARCH §5.3: the service-role key is for reviewed admin functions and jobs only.
// Reviewed importers of the admin client (extend only through code review):
const ADMIN_CLIENT_IMPORTERS = [
  "modules/identity-access/server/factory.ts", // builds the reviewed DriverAuth (attempt log, lockout, PIN admin)
  "modules/evidence-storage/server/factory.ts", // lazy admin factory, used only by the reviewed registration step
  "jobs/run.ts", // manual job runner (jobs may use the service role, ARCH §5.3)
];
const KEY_HOLDERS = ["lib/supabase/admin.ts"];

describe("service-role key hygiene", () => {
  it("the key variable is read only in the admin client module", () => {
    const offenders = files.filter(
      (f) => /SERVICE_ROLE/i.test(read(f)) && !KEY_HOLDERS.includes(rel(f)),
    );
    expect(offenders.map(rel)).toEqual([]);
  });

  it("is never exposed through a NEXT_PUBLIC_ variable", () => {
    expect(
      files.filter((f) => /NEXT_PUBLIC_[A-Z_]*SERVICE/.test(read(f))).map(rel),
    ).toEqual([]);
  });

  it("the admin client is server-only", () => {
    expect(read(path.join(SRC, "lib/supabase/admin.ts"))).toMatch(
      /^import "server-only";/m,
    );
  });

  it("only reviewed modules import the admin client", () => {
    const importers = files.filter((f) =>
      /supabase\/admin(\.ts)?["']/.test(read(f)),
    );
    expect(importers.map(rel).sort()).toEqual(
      [...ADMIN_CLIENT_IMPORTERS].sort(),
    );
  });

  it("every module that can hold the admin client is server-only", () => {
    for (const f of files.filter(
      (f) =>
        rel(f).startsWith("modules/identity-access/server/") &&
        !/actions\.ts$/.test(f),
    )) {
      expect(read(f), rel(f)).toMatch(/^import "server-only";/m);
    }
  });

  it("evidence server modules are server-only (except the 'use server' actions file)", () => {
    for (const f of files.filter(
      (f) =>
        rel(f).startsWith("modules/evidence-storage/server/") &&
        !/actions\.ts$/.test(f),
    )) {
      expect(read(f), rel(f)).toMatch(/^import "server-only";/m);
    }
  });

  it("evidence request-slot and signed-read paths never touch the service role", () => {
    for (const name of ["request-upload.ts", "read-url.ts"]) {
      const src = read(path.join(SRC, "modules/evidence-storage/server", name));
      expect(src, name).not.toMatch(/admin|service[_-]?role/i);
    }
  });

  it("only the reviewed registration step, its factory and the cleanup handler use an admin client for evidence", () => {
    const users = files.filter(
      (f) =>
        rel(f).startsWith("modules/evidence-storage/") &&
        /\badmin\b/.test(read(f)),
    );
    expect(users.map(rel).sort()).toEqual(
      [
        "modules/evidence-storage/server/cleanup.ts",
        "modules/evidence-storage/server/factory.ts",
        "modules/evidence-storage/server/register-upload.ts",
      ].sort(),
    );
  });

  it("client components never import server or admin code (except 'use server' actions)", () => {
    const clients = files.filter((f) => /^\s*["']use client["']/.test(read(f)));
    expect(clients.length).toBeGreaterThan(0);
    for (const f of clients) {
      const imports = [...read(f).matchAll(/from\s+["']([^"']+)["']/g)].map(
        (m) => m[1]!,
      );
      for (const i of imports) {
        expect(i, rel(f)).not.toMatch(
          /supabase\/admin|\/server\/(?!actions$)|supabase\/server/,
        );
      }
    }
  });

  it("the PIN admin function is not a client-invocable server action", () => {
    expect(
      read(path.join(SRC, "modules/identity-access/server/admin-pin.ts")),
    ).not.toMatch(/^\s*["']use server["']/m);
    expect(
      read(path.join(SRC, "modules/identity-access/server/actions.ts")),
    ).not.toMatch(/issueDriverPin|admin-pin/);
  });
});
