import { expect, test, type Page } from "@playwright/test";
import {
  admin,
  grant,
  makeDriver,
  makeStaff,
  totp,
  type World,
} from "../tests/integration/helpers";
import { E2E_COMPANY_ID } from "./global-setup";

// Slice 3C: allocate -> the driver starts it on a phone-sized screen; a supervisor starts a second one on the driver's
// behalf (permanently flagged, visible to both); a supervisor cancels a third with a reason. Needs local Supabase +
// synthetic data (E2E_AUTH=1, as in CI). Setup uses the service role (test infrastructure only); everything else is UI.
test.skip(process.env.E2E_AUTH !== "1", "requires local Supabase (E2E_AUTH=1)");

const PIN = "482916";
const dayOf = (d: Date) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Johannesburg" }).format(
    d,
  );

async function driverSignIn(page: Page, emp: string) {
  await page.goto("/sign-in");
  await page.getByLabel("Employee number").fill(emp);
  await page.getByLabel("PIN").fill(PIN);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/sign-in/);
}

test("start by the driver, start on behalf (badge), cancel with a reason", async ({
  page,
  browser,
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
  const boot = await makeStaff(w, "life-boot", "system_admin", null);
  const sup = await makeStaff(w, "life-sup", "supervisor", branch.id);
  await grant(w, sup.id, "supervisor", branch.id, boot.id);
  const verifier = await makeStaff(
    w,
    "life-verifier",
    "branch_manager",
    branch.id,
  );

  const plusYear = new Date(Date.now() + 365 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const people = [] as { emp: string; fleet: string }[];
  for (const tag of ["A", "B", "C"]) {
    const fleet = `LF-${run}${tag}`;
    const v = (
      await sa
        .from("vehicles")
        .insert({
          company_id: w.companyId,
          current_branch_id: branch.id,
          fleet_number: fleet,
          registration_number: `LF${run}${tag}`.slice(0, 20),
          make: "Synthetic",
          model: "Bakkie",
          vehicle_category: "bakkie",
        })
        .select("id")
        .single()
    ).data!;
    await sa
      .from("vehicles")
      .update({ required_licence_code: "B" })
      .eq("id", v.id);
    const emp = `LD${run}${tag}`;
    const drv = await makeDriver(w, emp, PIN, { branchId: branch.id });
    const row = (
      await sa
        .from("drivers")
        .insert({
          company_id: w.companyId,
          profile_id: drv.id,
          employee_number: emp,
          branch_id: branch.id,
        })
        .select("id")
        .single()
    ).data!;
    await sa.from("driver_licences").insert({
      company_id: w.companyId,
      driver_id: row.id,
      licence_number: `SYN-LF-${run}${tag}`,
      licence_code: "B",
      issue_date: "2020-01-01",
      expiry_date: plusYear,
      verification_status: "verified",
      verified_by: verifier.id,
      verified_at: new Date().toISOString(),
      client_submission_id: crypto.randomUUID(),
      created_by: boot.id,
    });
    people.push({ emp, fleet });
  }
  // a shift that started an hour ago and runs for 10 hours: the start window is open (planned times default to the shift's)
  const start = new Date(Date.now() - 3_600_000);
  const day = dayOf(start);
  await sa.from("shifts").insert({
    company_id: w.companyId,
    branch_id: branch.id,
    shift_date: day,
    scheduled_start_at: start.toISOString(),
    scheduled_end_at: new Date(start.getTime() + 11 * 3_600_000).toISOString(),
    client_submission_id: crypto.randomUUID(),
    created_by: boot.id,
  });

  // supervisor signs in (+ MFA, DEC-34) and allocates the three
  await page.goto("/staff/sign-in");
  await page.getByLabel("Email").fill(sup.email);
  await page.getByLabel("Password").fill(sup.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/mfa$/);
  await page.getByRole("button", { name: "Set up authenticator" }).click();
  const secret = (await page.locator("code").first().innerText()).trim();
  await page.getByLabel("6-digit code").fill(totp(secret));
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page).not.toHaveURL(/\/mfa$/);

  const board = `/shifts/allocations?branch=${branch.id}&date=${day}`;
  for (const p of people) {
    await page.goto(board);
    await page.getByRole("button", { name: "Allocate…" }).click();
    const dialog = page.getByRole("dialog");
    const value = async (id: string, text: string) =>
      (await dialog
        .locator(`#${id} option`, { hasText: text })
        .first()
        .getAttribute("value"))!;
    await dialog
      .getByLabel(/^Vehicle/)
      .selectOption(await value("vehicleId", p.fleet));
    await dialog
      .getByLabel(/^Driver/)
      .selectOption(await value("driverId", p.emp));
    await expect(dialog.getByTestId("eligibility")).toContainText("Allowed");
    await dialog.getByRole("button", { name: "Allocate", exact: true }).click();
    await expect(dialog.getByText("Allocation created.")).toBeVisible();
    await dialog.getByRole("button", { name: "Close" }).click();
  }

  // 1. the driver starts allocation A on a phone-sized screen
  const phone = await browser.newContext({
    viewport: { width: 390, height: 800 },
  });
  const dp = await phone.newPage();
  await driverSignIn(dp, people[0].emp);
  await dp.goto("/my-allocations");
  const card = dp
    .getByTestId("my-allocation")
    .filter({ hasText: people[0].fleet });
  await expect(card).toBeVisible();
  await expect(card.getByTestId("allocation-status")).toHaveText("Planned");
  await card.getByRole("button", { name: "Start" }).click();
  await expect(card.getByTestId("allocation-status")).toHaveText(
    "Pre-inspection pending",
  );

  // 1b. Slice 4A: the driver opens the pre-shift inspection (answers only; the camera arrives in 4B, so it stops before photos)
  await card.getByTestId("pre-shift-inspection-link").click();
  await expect(dp).toHaveURL(/\/inspection\/pre-shift$/);
  await dp.getByRole("button", { name: "Start inspection" }).click();
  const items = dp.getByTestId("inspection-item");
  await expect(items).toHaveCount(20);
  await expect(dp.getByText("Wheel nuts present and tight")).toBeVisible();
  const tyres = items.first();
  await tyres.getByRole("radio", { name: "Defect" }).click();
  await tyres.getByLabel(/^Comment:/).fill("Cut on the left front sidewall");
  await expect(dp.getByTestId("photo-slots")).toContainText(
    "Camera capture arrives in the next update",
  );
  await expect(dp.getByTestId("submit-blocked")).toContainText(
    "Submit stays disabled until the odometer photo is attached",
  );
  await expect(
    dp.getByRole("button", { name: "Submit inspection" }),
  ).toBeDisabled();
  await dp.getByRole("button", { name: "Save answers" }).click();
  await expect(dp.getByText("Answers saved.")).toBeVisible();
  await phone.close();

  // 1c. the supervisor sees the draft in the inspections list
  await page.goto(`/shifts/inspections?branch=${branch.id}&date=${day}`);
  await expect(
    page.getByTestId("inspection-row").filter({ hasText: people[0].fleet }),
  ).toContainText("Draft");

  // 2. the supervisor starts B on the driver's behalf, with a reason
  await page.goto(board);
  const rowB = page
    .getByTestId("allocation-row")
    .filter({ hasText: people[1].fleet });
  await rowB.getByRole("button", { name: "Start on driver's behalf" }).click();
  const dlg = page.getByRole("dialog");
  await expect(dlg).toContainText(
    "permanently recorded as started by supervisor",
  );
  await dlg.getByLabel(/^Reason/).fill("Driver's phone battery is flat");
  await dlg
    .getByRole("button", { name: "Start on driver's behalf" })
    .last()
    .click();
  await expect(dlg.getByText("Allocation started.")).toBeVisible();
  await dlg.getByRole("button", { name: "Close" }).click();
  await page.goto(board);
  await expect(
    page
      .getByTestId("allocation-row")
      .filter({ hasText: people[1].fleet })
      .getByTestId("started-by-supervisor"),
  ).toHaveText("Started by supervisor");
  // ... and on the driver's card
  const phone2 = await browser.newContext({
    viewport: { width: 390, height: 800 },
  });
  const dp2 = await phone2.newPage();
  await driverSignIn(dp2, people[1].emp);
  await dp2.goto("/my-allocations");
  const cardB = dp2
    .getByTestId("my-allocation")
    .filter({ hasText: people[1].fleet });
  await expect(cardB.getByTestId("started-by-supervisor")).toHaveText(
    "Started by supervisor",
  );
  await expect(cardB.getByTestId("allocation-status")).toHaveText(
    "Pre-inspection pending",
  );
  await phone2.close();

  // 3. the supervisor cancels C with a reason
  const rowC = page
    .getByTestId("allocation-row")
    .filter({ hasText: people[2].fleet });
  await rowC.getByRole("button", { name: "Cancel", exact: true }).click();
  const dlgC = page.getByRole("dialog");
  await dlgC.getByLabel(/^Reason/).fill("Vehicle needed at another site");
  await dlgC.getByRole("button", { name: "Cancel allocation" }).click();
  await expect(dlgC.getByText("Allocation cancelled.")).toBeVisible();
  await dlgC.getByRole("button", { name: "Close" }).click();
  await page.goto(board);
  await expect(
    page.getByTestId("allocation-row").filter({ hasText: people[2].fleet }),
  ).toContainText("Cancelled");
});
