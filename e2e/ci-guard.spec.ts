import { expect, test } from "@playwright/test";

// The database-backed specs skip themselves without E2E_AUTH=1. In CI that must never happen silently.
test("CI runs the database-backed specs (E2E_AUTH=1)", () => {
  if (process.env.CI) expect(process.env.E2E_AUTH).toBe("1");
});
