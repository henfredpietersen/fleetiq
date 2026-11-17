import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)
      ? [full]
      : [];
  });
}

// Phase 1A has no jobs or admin functions, so no source may touch the service-role key.
describe("service-role key hygiene", () => {
  const files = sourceFiles(path.resolve(__dirname, "../.."));

  it("is never referenced from src", () => {
    const offenders = files.filter((f) =>
      /service_?role/i.test(readFileSync(f, "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("is never exposed through a NEXT_PUBLIC_ variable", () => {
    const offenders = files.filter((f) =>
      /NEXT_PUBLIC_[A-Z_]*SERVICE/.test(readFileSync(f, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
