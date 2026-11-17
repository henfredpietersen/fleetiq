import { expect, test } from "@playwright/test";

test("home page renders the placeholder on a mobile viewport", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "FleetIQ — setup in progress" }),
  ).toBeVisible();
  // No horizontal overflow on a phone-sized viewport.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
});
