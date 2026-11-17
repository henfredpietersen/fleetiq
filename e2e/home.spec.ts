import { expect, test } from "@playwright/test";

test("signed-out visitors land on the driver sign-in screen (mobile viewport)", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(
    page.getByRole("heading", { name: "Driver sign-in" }),
  ).toBeVisible();
  await expect(page.getByLabel("Employee number")).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
});

test("protected pages redirect to sign-in without a session", async ({
  page,
}) => {
  await page.goto("/home");
  await expect(page).toHaveURL(/\/sign-in$/);
});
