import { expect, type Page } from "@playwright/test";
import {
  admin,
  grant,
  makeDriver,
  makeStaff,
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
  status: "pre_inspection_pending" | "in_use";
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
      opened_at: start.toISOString(),
      opened_by: drv.id,
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
    day,
    bootId: boot.id,
    driverProfileId: drv.id,
  };
}
