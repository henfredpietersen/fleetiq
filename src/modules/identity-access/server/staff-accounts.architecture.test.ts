import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Carry-over C3: "every path that sets a staff password goes through the policy" is enforced structurally.
// Only these production files may call Supabase Auth's password-setting APIs:
//   - staff-accounts.ts          staff create / reset / change (validates the staff policy first)
//   - supabase-driver-auth.ts    driver PIN change / issue (validates the PIN rules; targets drivers only)
const ALLOWED = new Set([
  "src/modules/identity-access/server/staff-accounts.ts",
  "src/modules/identity-access/server/supabase-driver-auth.ts",
  //   - driver-accounts.ts         creates the driver Auth user with a generated PIN that follows the PIN rules
  "src/modules/identity-access/server/driver-accounts.ts",
]);
const PASSWORD_SETTERS = [
  /\.admin\.createUser\s*\(/,
  /\.admin\.updateUserById\s*\(/,
  /\.auth\.updateUser\s*\(/,
  /\.admin\.generateLink\s*\(/, // recovery links set a password out-of-band
  /\.resetPasswordForEmail\s*\(/,
];

const ROOT = path.resolve(__dirname, "../../../..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name))
      out.push(full);
  }
  return out;
}

describe("staff password paths", () => {
  it("no production code outside the allow-list sets an Auth password", () => {
    const offenders: string[] = [];
    for (const file of walk(path.join(ROOT, "src"))) {
      const rel = path.relative(ROOT, file).split(path.sep).join("/");
      if (ALLOWED.has(rel)) continue;
      const src = readFileSync(file, "utf8");
      for (const re of PASSWORD_SETTERS) {
        if (re.test(src)) offenders.push(`${rel} matches ${re}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the allow-list is real (the scan would catch a regression)", () => {
    const staff = readFileSync(
      path.join(ROOT, "src/modules/identity-access/server/staff-accounts.ts"),
      "utf8",
    );
    expect(PASSWORD_SETTERS.some((re) => re.test(staff))).toBe(true);
    expect(staff).toContain("validateStaffPassword");
  });
});
