import { expect, test } from "@playwright/test";

// Needs local Supabase + seeded synthetic users (e2e/global-setup.ts). CI sets E2E_AUTH=1.
test.skip(process.env.E2E_AUTH !== "1", "requires local Supabase (E2E_AUTH=1)");

const PIN = "482916";

async function signIn(
  page: import("@playwright/test").Page,
  emp: string,
  pin: string,
) {
  await page.goto("/sign-in");
  await page.getByLabel("Employee number").fill(emp);
  await page.getByLabel("PIN").fill(pin);
  await page.getByRole("button", { name: "Sign in" }).click();
}

test("driver signs in, sees role and branch scope, and signs out", async ({
  page,
}) => {
  await signIn(page, process.env.E2E_EMP_OK!, PIN);
  await expect(page).toHaveURL(/\/home$/);
  await expect(page.getByRole("heading", { name: "Signed in" })).toBeVisible();
  await expect(page.getByText("Branch: E2E Branch")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    ),
  ).toBe(false);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.goto("/home");
  await expect(page).toHaveURL(/\/sign-in$/);
});

test("wrong credentials show one generic message", async ({ page }) => {
  await signIn(page, "NOSUCHNUMBER1", "999111");
  await expect(page.locator("[data-slot=alert]")).toHaveText(
    "Employee number or PIN is incorrect.",
  );
  await signIn(page, process.env.E2E_EMP_OK!, "999111");
  await expect(page.locator("[data-slot=alert]")).toHaveText(
    "Employee number or PIN is incorrect.",
  );
});

test("repeated failures lock the account, even for the right PIN", async ({
  page,
}) => {
  const emp = process.env.E2E_EMP_LOCK!;
  for (let i = 0; i < 5; i++) await signIn(page, emp, "999111");
  await expect(page.locator("[data-slot=alert]")).toContainText(
    "Too many attempts",
  );
  await signIn(page, emp, PIN);
  await expect(page.locator("[data-slot=alert]")).toContainText(
    "Too many attempts",
  );
  await expect(page).toHaveURL(/\/sign-in$/);
});

test("a driver with a temporary PIN must change it before anything else", async ({
  page,
}) => {
  await signIn(page, process.env.E2E_EMP_CHANGE!, PIN);
  await expect(page).toHaveURL(/\/change-pin$/);
  await page.goto("/home");
  await expect(page).toHaveURL(/\/change-pin$/);
  await page.getByLabel("New PIN", { exact: true }).fill("123456");
  await page.getByLabel("Confirm new PIN").fill("123456");
  await page.getByRole("button", { name: "Save new PIN" }).click();
  await expect(page.locator("[data-slot=alert]")).toContainText("not allowed");
  await page.getByLabel("New PIN", { exact: true }).fill("739051");
  await page.getByLabel("Confirm new PIN").fill("739051");
  await page.getByRole("button", { name: "Save new PIN" }).click();
  await expect(page).toHaveURL(/\/home$/);
});
