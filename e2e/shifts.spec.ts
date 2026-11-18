import { expect, test } from "@playwright/test";
import {
  admin,
  grant,
  makeStaff,
  totp,
  type World,
} from "../tests/integration/helpers";
import { E2E_COMPANY_ID } from "./global-setup";

// Slice 3A happy path (desktop screens): a supervisor signs in with MFA, creates a night template (crosses midnight),
// generates shifts, sees a re-run skip them, and cancels one with a reason.
// Needs local Supabase + synthetic users (CI sets E2E_AUTH=1). The management screens are desktop-first, so this file
// uses a desktop viewport inside the mobile project.
test.skip(process.env.E2E_AUTH !== "1", "requires local Supabase (E2E_AUTH=1)");
test.use({
  viewport: { width: 1280, height: 900 },
  isMobile: false,
  hasTouch: false,
});

const localDate = (offsetDays: number) => {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Johannesburg",
  }).format(d);
};

test("supervisor creates a template, generates shifts, re-runs (skipped) and cancels one", async ({
  page,
}) => {
  const sa = admin();
  const { data: branch } = await sa
    .from("branches")
    .select("id")
    .eq("company_id", E2E_COMPANY_ID)
    .eq("branch_code", "E2E")
    .single();
  const w: World = {
    companyId: E2E_COMPANY_ID,
    branchId: branch!.id,
    otherBranchId: branch!.id,
    sa,
  };
  const boot = await makeStaff(w, "e2e-shifts-boot", "system_admin", null);
  const sup = await makeStaff(w, "e2e-shifts-sup", "supervisor", w.branchId);
  await grant(w, sup.id, "supervisor", w.branchId, boot.id);

  // sign in (email + password), then enrol an authenticator: supervisors hold approval permissions (DEC-34)
  await page.goto("/staff/sign-in");
  await page.getByLabel("Email").fill(sup.email);
  await page.getByLabel("Password").fill(sup.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/mfa$/);
  await page.getByRole("button", { name: "Set up authenticator" }).click();
  const secret = (await page.locator("code.font-mono").innerText()).trim();
  await page.getByLabel("6-digit code").fill(totp(secret));
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page).toHaveURL(/\/home$/);

  // the navigation entry is there for someone who holds allocation.manage
  await page.goto("/shifts/templates");
  await expect(
    page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Shifts" }),
  ).toBeVisible();

  // create a night template (unique per run: active names are unique per branch)
  const name = `Night ${Date.now().toString(36)}`;
  const createForm = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Create template" }) });
  await createForm.getByLabel("Name").fill(name);
  await createForm.getByLabel("Start time").fill("18:00");
  await createForm.getByLabel("End time").fill("06:00");
  await createForm.getByRole("button", { name: "Create template" }).click();
  await expect(page.getByText("Shift template created.")).toBeVisible();
  const row = page.getByTestId("template-row").filter({ hasText: name });
  await expect(row).toContainText("18:00–06:00");
  await expect(row.getByText("Crosses midnight")).toBeVisible();

  // generate three days
  const from = localDate(0);
  const to = localDate(2);
  await page.goto(`/shifts?from=${from}&to=${to}`);
  await expect(
    page
      .getByText("No shifts in this range.")
      .or(page.getByTestId("shift-row").first()),
  ).toBeVisible();
  await page.getByRole("button", { name: "Generate shifts…" }).click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Template")
    .selectOption({ label: `${name} (18:00–06:00)` });
  await dialog.getByLabel("From").fill(from);
  await dialog.getByLabel("To").fill(to);
  await dialog.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(
    dialog.getByText("Created 3 shifts, skipped 0 (already scheduled)."),
  ).toBeVisible();

  // running it again creates none and skips all three
  await dialog.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(
    dialog.getByText("Created 0 shifts, skipped 3 (already scheduled)."),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Close" }).click();

  // the three night shifts end the next day
  await page.reload();
  const nights = page.getByTestId("shift-row").filter({ hasText: name });
  await expect(nights).toHaveCount(3);
  await expect(nights.first()).toContainText("18:00–06:00 (+1 day)");
  await expect(nights.first()).toContainText("Scheduled");

  // cancel one with a reason
  await nights.first().getByText("Cancel…").click();
  await nights
    .first()
    .getByLabel("Reason for cancelling")
    .fill("Public holiday");
  await nights.first().getByRole("button", { name: "Cancel shift" }).click();
  await expect(nights.first().getByText("Cancelled")).toBeVisible();
  await expect(nights.first()).toContainText("Public holiday");
});
