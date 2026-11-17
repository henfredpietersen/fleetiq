import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EVIDENCE_PURPOSES, UPLOAD_PERMISSION } from "./purposes";

// The database is the authority; the app mirror must not drift from it.
const sql = readFileSync(
  path.resolve(
    __dirname,
    "../../../../supabase/migrations/20261117000010_evidence_storage.sql",
  ),
  "utf8",
);

describe("purpose -> permission map equals the database function", () => {
  it.each(EVIDENCE_PURPOSES)("%s", (purpose) => {
    expect(sql).toMatch(
      new RegExp(
        `when '${purpose}'\\s+then '${UPLOAD_PERMISSION[purpose].replace(".", "\\.")}'`,
      ),
    );
  });
  it("every purpose in the database CHECK is known to the app", () => {
    const check = sql.match(/purpose in\s*\(([^)]*)\)/)![1]!;
    const dbPurposes = [...check.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(dbPurposes.sort()).toEqual([...EVIDENCE_PURPOSES].sort());
  });
  it("only permissions that exist in the DEC-23 seed are used", () => {
    const seed = readFileSync(
      path.resolve(
        __dirname,
        "../../../../supabase/migrations/20261117000005_seed_roles_permissions.sql",
      ),
      "utf8",
    );
    for (const key of Object.values(UPLOAD_PERMISSION))
      expect(seed).toContain(`'${key}'`);
  });
});
