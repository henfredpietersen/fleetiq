import { devices, expect, test } from "@playwright/test";
import {
  answerChecklist,
  branchStaff,
  driverScenario,
  driverSignIn,
  staffSignIn,
  takeCameraPhoto,
} from "./scenario";

// Slice 4C (DEC-09) end to end: the driver ends the shift but cannot finish; the supervisor is told to void the driver's draft first,
// does, then completes the post-shift inspection on the driver's behalf with a reason; the detail shows the banner, the reason and the
// neutral device wording (never an alarm); the allocation shows awaiting closure. Needs local Supabase (E2E_AUTH=1, as in CI).
test.skip(process.env.E2E_AUTH !== "1", "requires local Supabase (E2E_AUTH=1)");

const phone = {
  ...devices["Pixel 5"],
  permissions: ["camera", "geolocation"] as string[],
  geolocation: { latitude: -26.2041, longitude: 28.0473 },
};
const desk = {
  viewport: { width: 1280, height: 900 },
  permissions: ["camera", "geolocation"] as string[],
  geolocation: { latitude: -26.2041, longitude: 28.0473 },
};
const REASON = "Driver's phone broke; the supervisor completed it";

test("driver cannot finish; supervisor voids the draft and completes the post-shift inspection on their behalf", async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const s = await driverScenario({ tag: "OB", status: "in_use" });
  const sup = await branchStaff(s, "ob-sup", "supervisor");
  const mgr = await branchStaff(s, "ob-mgr", "branch_manager"); // allocation.manage but no inspection.submit

  // --- the driver ends the shift and starts the post-shift inspection, then cannot finish it
  const dctx = await browser.newContext(phone);
  const dp = await dctx.newPage();
  await driverSignIn(dp, s.emp);
  await dp.goto("/my-allocations");
  await dp
    .getByTestId("my-allocation")
    .filter({ hasText: s.fleet })
    .getByRole("link", { name: "End shift — post-shift inspection" })
    .click();
  await dp.getByRole("button", { name: "Start post-shift inspection" }).click();
  await expect(
    dp.getByRole("button", { name: "This is the vehicle I am inspecting" }),
  ).toBeVisible();

  // --- a branch manager without inspection.submit does not get the button
  const mctx = await browser.newContext(desk);
  const mp = await mctx.newPage();
  await staffSignIn(mp, mgr);
  await mp.goto(`/shifts/allocations?branch=${s.branchId}&date=${s.day}`);
  const mrow = mp.getByRole("row").filter({ hasText: s.fleet });
  await expect(mrow).toBeVisible();
  await expect(
    mrow.getByRole("button", { name: "Complete post-shift for the driver" }),
  ).toHaveCount(0);

  // --- the supervisor: refused while the driver's draft exists
  const sctx = await browser.newContext(desk);
  const sp = await sctx.newPage();
  await staffSignIn(sp, sup);
  await sp.goto(`/shifts/allocations?branch=${s.branchId}&date=${s.day}`);
  const row = sp.getByRole("row").filter({ hasText: s.fleet });
  await row
    .getByRole("button", { name: "Complete post-shift for the driver" })
    .click();
  const dlg = sp.getByRole("dialog", {
    name: "Complete the post-shift inspection for the driver",
  });
  await dlg
    .getByLabel("Why are you completing it for the driver?")
    .fill(REASON);
  await dlg.getByRole("button", { name: "Start completing it" }).click();
  await expect(dlg.getByRole("alert")).toContainText(
    "Void the driver's draft first",
  );
  await dlg.getByRole("button", { name: "Cancel" }).click();

  // --- void the driver's draft (the supervisor did not complete it, so DEC-24 allows it)
  const { data: draft } = await s.sa
    .from("inspections")
    .select("id")
    .eq("allocation_id", s.allocationId)
    .eq("inspection_stage", "post_shift")
    .single();
  await sp.goto(`/shifts/inspections/${draft!.id}`);
  await sp.getByRole("button", { name: "Void this inspection" }).click();
  await sp
    .getByLabel("Reason for voiding")
    .fill("The driver could not finish; completing it for them");
  await sp.getByRole("button", { name: "Void", exact: true }).click();
  await expect(sp.getByText("Inspection voided.")).toBeVisible();

  // --- now complete it on the driver's behalf, with a reason
  await sp.goto(`/shifts/allocations?branch=${s.branchId}&date=${s.day}`);
  await sp
    .getByRole("row")
    .filter({ hasText: s.fleet })
    .getByRole("button", { name: "Complete post-shift for the driver" })
    .click();
  const dlg2 = sp.getByRole("dialog", {
    name: "Complete the post-shift inspection for the driver",
  });
  await dlg2
    .getByLabel("Why are you completing it for the driver?")
    .fill(REASON);
  await dlg2.getByRole("button", { name: "Start completing it" }).click();
  await expect(sp).toHaveURL(
    new RegExp(`/shifts/allocations/${s.allocationId}/on-behalf$`),
  );
  await expect(sp.getByTestId("on-behalf-banner")).toHaveText(
    `Completing on behalf of the driver — reason: ${REASON}`,
  );
  await sp
    .getByRole("button", { name: "This is the vehicle I am inspecting" })
    .click();
  await expect(sp.getByTestId("on-behalf-banner")).toBeVisible(); // the banner stays on every step
  await sp.getByRole("button", { name: "I have checked this list" }).click();
  await answerChecklist(sp);
  await sp.getByRole("button", { name: "Next", exact: true }).click();
  await takeCameraPhoto(
    sp,
    sp.getByRole("button", { name: "Take odometer photo" }),
    { acknowledge: true },
  );
  await expect(
    sp.getByTestId("odometer-step").getByText("Attached", { exact: true }),
  ).toBeVisible();
  await sp.getByRole("button", { name: "Next", exact: true }).click();
  await expect(sp.getByTestId("review-step")).toContainText(
    "Everything is in place",
  );
  await sp.getByRole("button", { name: "Submit inspection" }).click();
  await expect(sp.getByTestId("inspection-submitted")).toContainText(
    "Post-shift inspection submitted.",
  );
  await expect(sp.getByTestId("on-behalf-banner")).toBeVisible();

  // --- the detail: banner, reason, neutral device wording (never an alarm), the badge in the list
  const { data: live } = await s.sa
    .from("inspections")
    .select("id, status, completed_by_role, on_behalf_reason, device_flag")
    .eq("allocation_id", s.allocationId)
    .eq("inspection_stage", "post_shift")
    .neq("status", "void")
    .single();
  expect(live).toMatchObject({
    status: "submitted",
    completed_by_role: "supervisor_on_behalf",
    on_behalf_reason: REASON,
  });
  expect(live!.device_flag).not.toBeNull(); // stored as computed against the driver's phone, never blocking
  await sp.goto(`/shifts/inspections/${live!.id}`);
  await expect(sp.getByTestId("on-behalf-detail")).toContainText(REASON);
  await expect(sp.getByTestId("on-behalf-device-text")).toHaveText(
    "Completed by supervisor on their own phone.",
  );
  await expect(sp.getByTestId("device-flag")).toHaveCount(0);
  await expect(sp.getByTestId("inspection-badges")).toContainText(
    "Completed by supervisor",
  );
  await sp.goto(
    `/shifts/inspections?branch=${s.branchId}&date=${s.day}&onbehalf=1`,
  );
  await expect(
    sp.getByTestId("inspection-row").filter({ hasText: s.fleet }),
  ).toContainText("Completed by supervisor");
  // the supervisor cannot void what they completed themselves
  await sp.goto(`/shifts/inspections/${live!.id}`);
  await expect(
    sp.getByRole("button", { name: "Void this inspection" }),
  ).toHaveCount(0);

  // --- the allocation awaits closure (Phase 5); the driver can no longer change anything
  await dp.goto("/my-allocations");
  await expect(
    dp
      .getByTestId("my-allocation")
      .filter({ hasText: s.fleet })
      .getByTestId("allocation-status"),
  ).toHaveText("Awaiting post-shift closure");
  const { data: alloc } = await s.sa
    .from("vehicle_allocations")
    .select("status")
    .eq("id", s.allocationId)
    .single();
  expect(alloc!.status).toBe("post_inspection_pending");
  const { data: ev } = await s.sa
    .from("allocation_events")
    .select("reason, metadata")
    .eq("allocation_id", s.allocationId)
    .eq("new_value->>status", "post_inspection_pending")
    .maybeSingle();
  expect(ev).not.toBeNull();

  await dctx.close();
  await sctx.close();
  await mctx.close();
});
