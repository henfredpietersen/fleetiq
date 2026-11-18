import { expect, test } from "@playwright/test";
import {
  admin,
  grant,
  makeDriver,
  makeStaff,
  totp,
  type World,
} from "../tests/integration/helpers";
import { E2E_COMPANY_ID } from "./global-setup";

// Slice 3B happy path: a supervisor allocates an available vehicle and an eligible driver to a shift on the allocation
// board. Needs local Supabase + synthetic data (E2E_AUTH=1, as in CI). Everything is created here with the service role
// (test infrastructure only) and is synthetic; the supervisor then works through the real UI, including MFA (DEC-34).
test.skip(process.env.E2E_AUTH !== "1", "requires local Supabase (E2E_AUTH=1)");

const localToday = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Africa/Johannesburg",
}).format(new Date());

test("a supervisor allocates a vehicle and a driver to a shift, with the licence checked in plain words", async ({
  page,
}) => {
  const run = Date.now().toString(36).toUpperCase();
  const sa = admin();
  const branch = (
    await sa
      .from("branches")
      .select("id")
      .eq("company_id", E2E_COMPANY_ID)
      .eq("branch_code", "E2E")
      .single()
  ).data!;
  const w: World = {
    companyId: E2E_COMPANY_ID,
    branchId: branch.id,
    otherBranchId: branch.id,
    sa,
  };
  const boot = await makeStaff(w, "alloc-boot", "system_admin", null);
  const sup = await makeStaff(w, "alloc-sup", "supervisor", branch.id);
  await grant(w, sup.id, "supervisor", branch.id, boot.id);
  const verifier = await makeStaff(
    w,
    "alloc-verifier",
    "branch_manager",
    branch.id,
  );

  const fleetNumber = `AL-${run}`;
  const vehicle = (
    await sa
      .from("vehicles")
      .insert({
        company_id: w.companyId,
        current_branch_id: branch.id,
        fleet_number: fleetNumber,
        registration_number: `AL${run}`.slice(0, 20),
        make: "Synthetic",
        model: "Bakkie",
        vehicle_category: "bakkie",
      })
      .select("id")
      .single()
  ).data!;
  // The column is not client-writable; the service role (a reviewed admin path) sets it, like the seed does.
  await sa
    .from("vehicles")
    .update({ required_licence_code: "B" })
    .eq("id", vehicle.id);

  const empNo = `AD${run}`;
  const drv = await makeDriver(w, empNo, "482916", { branchId: branch.id });
  const driverRow = (
    await sa
      .from("drivers")
      .insert({
        company_id: w.companyId,
        profile_id: drv.id,
        employee_number: empNo,
        branch_id: branch.id,
      })
      .select("id")
      .single()
  ).data!;
  const plusYear = new Date(Date.now() + 365 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  await sa.from("driver_licences").insert({
    company_id: w.companyId,
    driver_id: driverRow.id,
    licence_number: `SYN-${run}`,
    licence_code: "B",
    issue_date: "2020-01-01",
    expiry_date: plusYear,
    verification_status: "verified",
    verified_by: verifier.id,
    verified_at: new Date().toISOString(),
    client_submission_id: crypto.randomUUID(),
    created_by: boot.id,
  });
  await sa.from("shifts").insert({
    company_id: w.companyId,
    branch_id: branch.id,
    shift_date: localToday,
    scheduled_start_at: `${localToday}T04:00:00Z`, // 06:00 Africa/Johannesburg (UTC+2, no DST)
    scheduled_end_at: `${localToday}T16:00:00Z`,
    client_submission_id: crypto.randomUUID(),
    created_by: boot.id,
  });

  // Staff sign-in, then the MFA enrolment the supervisor role requires (DEC-34).
  await page.goto("/staff/sign-in");
  await page.getByLabel("Email").fill(sup.email);
  await page.getByLabel("Password").fill(sup.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/mfa$/);
  await page.getByRole("button", { name: "Set up authenticator" }).click();
  const secret = (await page.locator("code").first().innerText()).trim();
  await page.getByLabel("6-digit code").fill(totp(secret));
  await page.getByRole("button", { name: "Verify" }).click();

  await page.goto(`/shifts/allocations?branch=${branch.id}&date=${localToday}`);
  await expect(
    page.getByRole("heading", { name: "Allocations" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Allocate…" }).click();
  const dialog = page.getByRole("dialog");
  const optionValue = async (selectId: string, text: string) =>
    (await dialog
      .locator(`#${selectId} option`, { hasText: text })
      .first()
      .getAttribute("value"))!;
  await dialog
    .getByLabel(/^Vehicle/)
    .selectOption(await optionValue("vehicleId", fleetNumber));
  await dialog
    .getByLabel(/^Driver/)
    .selectOption(await optionValue("driverId", empNo));

  // The answer is shown in plain words before anything is submitted.
  await expect(dialog.getByTestId("eligibility")).toContainText(
    "The driver's licence is valid and covers this vehicle",
  );
  await dialog.getByRole("button", { name: "Allocate", exact: true }).click();
  await expect(dialog.getByText("Allocation created.")).toBeVisible();
  await dialog.getByRole("button", { name: "Close" }).click();

  // The board shows it with the licence badge.
  const row = page
    .getByTestId("allocation-row")
    .filter({ hasText: fleetNumber });
  await expect(row).toBeVisible();
  await expect(row).toContainText(empNo);
  await expect(row).toContainText("Planned");
  await expect(row).toContainText("Licence matched");
});
