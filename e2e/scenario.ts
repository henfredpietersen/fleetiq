import { expect, type Locator, type Page } from "@playwright/test";
import {
  admin,
  grant,
  makeDriver,
  makeStaff,
  totp,
  type World,
} from "../tests/integration/helpers";
import { E2E_COMPANY_ID } from "./global-setup";

// Synthetic scenario for driver specs (service role = test infrastructure only; everything under test goes through the UI).
export const PIN = "482916";

export async function driverSignIn(page: Page, emp: string) {
  await page.goto("/sign-in");
  await page.getByLabel("Employee number").fill(emp);
  await page.getByLabel("PIN").fill(PIN);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/sign-in/);
}

/** One driver with a verified licence, one vehicle, a shift that began `startedMinutesAgo` ago and ONE allocation in `status`. */
export async function driverScenario(opts: {
  tag: string;
  status: "planned" | "pre_inspection_pending" | "in_use";
  startedMinutesAgo?: number;
}) {
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
  const boot = await makeStaff(w, `sc-boot-${opts.tag}`, "system_admin", null);
  const verifier = await makeStaff(
    w,
    `sc-ver-${opts.tag}`,
    "branch_manager",
    branch.id,
  );
  const fleet = `SC-${opts.tag}${run}`;
  const v = (
    await sa
      .from("vehicles")
      .insert({
        company_id: w.companyId,
        current_branch_id: branch.id,
        fleet_number: fleet,
        registration_number: `SC${opts.tag}${run}`.slice(0, 20),
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
  const emp = `SD${opts.tag}${run}`;
  const drv = await makeDriver(w, emp, PIN, { branchId: branch.id });
  await grant(w, drv.id, "driver", branch.id, boot.id);
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
    licence_number: `SYN-SC-${opts.tag}${run}`,
    licence_code: "B",
    issue_date: "2020-01-01",
    expiry_date: new Date(Date.now() + 365 * 86_400_000)
      .toISOString()
      .slice(0, 10),
    verification_status: "verified",
    verified_by: verifier.id,
    verified_at: new Date().toISOString(),
    client_submission_id: crypto.randomUUID(),
    created_by: boot.id,
  });
  const start = new Date(Date.now() - (opts.startedMinutesAgo ?? 5) * 60_000);
  const end = new Date(start.getTime() + 11 * 3_600_000);
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Johannesburg",
  }).format(start);
  const shift = (
    await sa
      .from("shifts")
      .insert({
        company_id: w.companyId,
        branch_id: branch.id,
        shift_date: day,
        scheduled_start_at: start.toISOString(),
        scheduled_end_at: end.toISOString(),
        client_submission_id: crypto.randomUUID(),
        created_by: boot.id,
      })
      .select("id")
      .single()
  ).data!;
  const alloc = await sa
    .from("vehicle_allocations")
    .insert({
      company_id: w.companyId,
      branch_id: branch.id,
      vehicle_id: v.id,
      driver_id: row.id,
      shift_id: shift.id,
      planned_start_at: start.toISOString(),
      planned_end_at: end.toISOString(),
      status: opts.status,
      started_at: opts.status === "in_use" ? start.toISOString() : null,
      opened_at: opts.status === "planned" ? null : start.toISOString(),
      opened_by: opts.status === "planned" ? null : drv.id,
      licence_class_check: "matched",
      client_submission_id: crypto.randomUUID(),
      created_by: boot.id,
    })
    .select("id")
    .single();
  if (alloc.error) throw new Error(alloc.error.message);
  return {
    w,
    sa,
    emp,
    fleet,
    branchId: branch.id,
    allocationId: alloc.data!.id,
    vehicleId: v.id,
    day,
    bootId: boot.id,
    driverProfileId: drv.id,
  };
}

/** Staff sign-in with the MFA set-up that DEC-34 requires (as the 3C lifecycle spec does). Returns once signed in. */
export async function staffSignIn(
  page: Page,
  staff: { email: string; password: string },
): Promise<string> {
  await page.goto("/staff/sign-in");
  await page.getByLabel("Email").fill(staff.email);
  await page.getByLabel("Password").fill(staff.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/mfa$/);
  await page.getByRole("button", { name: "Set up authenticator" }).click();
  const secret = (await page.locator("code").first().innerText()).trim();
  await page.getByLabel("6-digit code").fill(totp(secret));
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page).not.toHaveURL(/\/mfa$/);
  return secret; // lets a spec step a direct API client up to AAL2 on the same authenticator
}

/**
 * Take one photo with the in-app camera: open it from `trigger`, get past the first-use notice when it appears, press the
 * shutter, "Use photo". Resolves when the camera has closed.
 */
export async function takeCameraPhoto(
  page: Page,
  trigger: Locator,
  opts: { acknowledge?: boolean } = {},
) {
  await trigger.click();
  const cam = page.getByTestId("camera");
  await expect(cam).toBeVisible();
  if (opts.acknowledge) {
    await expect(cam.getByTestId("camera-notice")).toContainText(
      "kept for 5 years",
    );
    await cam.getByRole("button", { name: "I understand" }).click();
  }
  const shutter = cam.getByRole("button", { name: "Take photo" });
  await expect(shutter).toBeEnabled({ timeout: 20_000 });
  await shutter.click();
  await expect(cam.getByTestId("camera-review")).toBeVisible();
  await cam.getByRole("button", { name: "Use photo" }).click();
  await expect(cam).toBeHidden();
}

/** Answer every checklist item "fine" (OK / half a tank / No), optionally making the first item a Defect with a comment. */
export async function answerChecklist(
  page: Page,
  opts: { firstItemDefect?: string } = {},
) {
  const items = page.getByTestId("inspection-item");
  await expect(items.first()).toBeVisible(); // count() does not wait: an empty count would answer nothing
  const n = await items.count();
  for (let i = 0; i < n; i++) {
    const item = items.nth(i);
    if (i === 0 && opts.firstItemDefect) {
      await item.getByRole("radio", { name: "Defect" }).click();
      await item.getByLabel(/^Comment:/).fill(opts.firstItemDefect);
      continue;
    }
    const ok = item.getByRole("radio", { name: "OK", exact: true });
    if (await ok.count()) {
      await ok.click();
      continue;
    }
    const half = item.getByRole("radio", { name: "½" });
    if (await half.count()) {
      await half.click();
      continue;
    }
    await item.getByRole("radio", { name: "No", exact: true }).click();
  }
}

/** A staff member in the scenario's branch with a branch-scoped role (the matrix of DEC-23 decides what they can do). */
export async function branchStaff(
  s: Awaited<ReturnType<typeof driverScenario>>,
  label: string,
  role: "supervisor" | "branch_manager" | "fleet_admin" | "maintenance_admin",
) {
  const { makeStaff, grant } = await import("../tests/integration/helpers");
  const u = await makeStaff(s.w, label, role, s.branchId);
  await grant(s.w, u.id, role, s.branchId, s.bootId);
  return u;
}

/** 5A (DEC-05): type the odometer reading shown in the photo (whole km, digits only). The field is enabled once the photo is saved. */
export async function enterReading(page: Page, km: number | string) {
  const f = page.getByLabel("Odometer reading (km)");
  await expect(f).toBeEnabled();
  await f.fill(String(km));
}
