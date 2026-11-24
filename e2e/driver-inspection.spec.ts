import { devices, expect, test } from "@playwright/test";
import { grant, makeStaff } from "../tests/integration/helpers";
import {
  answerChecklist,
  driverScenario,
  driverSignIn,
  staffSignIn,
  takeCameraPhoto,
} from "./scenario";

// Slice 4B end to end on a Pixel 5 with Chromium's fake camera: a company phone is registered and issued through the admin screen,
// the driver completes the pre-shift inspection (one Defect with comment + photo, odometer photo), submits (allocation in use),
// ends the shift behind the confirmation, completes the post-shift inspection (awaiting post-shift closure), and a supervisor
// reads it back (photo through the signed-URL path, location behind its own button). Needs local Supabase (E2E_AUTH=1, as in CI).
test.skip(process.env.E2E_AUTH !== "1", "requires local Supabase (E2E_AUTH=1)");

const phone = {
  ...devices["Pixel 5"],
  permissions: ["camera", "geolocation"] as string[],
  geolocation: { latitude: -26.2041, longitude: 28.0473 },
};

test("register + issue the phone, pre-shift with a defect, submit, end shift, post-shift, supervisor review", async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const s = await driverScenario({
    tag: "P",
    status: "pre_inspection_pending",
  });
  const fa = await makeStaff(s.w, "ins-fa", "fleet_admin", null);
  await grant(s.w, fa.id, "fleet_admin", null, s.bootId);

  // --- the driver's phone
  const dctx = await browser.newContext(phone);
  const dp = await dctx.newPage();
  await driverSignIn(dp, s.emp);
  await dp.goto("/this-phone");
  const code = (await dp.getByTestId("full-code").innerText()).trim();
  expect(code).toMatch(/^[0-9a-f-]{36}$/);
  await expect(dp.getByTestId("short-code")).toHaveText(
    /^[0-9A-F]{4}-[0-9A-F]{4}$/,
  );

  // --- the administrator registers that phone and issues it to the driver
  const actx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  const ap = await actx.newPage();
  await staffSignIn(ap, fa);
  await ap.goto("/drivers/devices");
  await ap.getByLabel("Branch").first().selectOption({ label: "E2E Branch" });
  await ap.getByLabel("Phone code").fill(code);
  await ap.getByLabel("Label (optional)").fill(`E2E phone ${s.fleet}`);
  await ap.getByRole("button", { name: "Register phone" }).click();
  await expect(ap.getByText("Phone registered.")).toBeVisible();
  await ap.reload();
  const row = ap
    .getByTestId("device-row")
    .filter({ hasText: `E2E phone ${s.fleet}` });
  await expect(row).toContainText("Not issued");
  await row.getByPlaceholder("Reason (required)").fill("Issued at induction");
  await row
    .getByRole("combobox")
    .selectOption({ label: `${s.emp} · Driver ${s.emp}` });
  await row.getByRole("button", { name: "Assign" }).click();
  await expect(row.getByText("Phone assigned.")).toBeVisible();

  // --- pre-shift inspection
  await dp.goto("/my-allocations");
  const card = dp.getByTestId("my-allocation").filter({ hasText: s.fleet });
  await expect(card.getByTestId("allocation-status")).toHaveText(
    "Pre-inspection pending",
  );
  await card.getByTestId("pre-shift-inspection-link").click();
  await expect(dp.locator('input[type="file"], [capture]')).toHaveCount(0); // no file picker anywhere (DEC-04)
  await dp.getByRole("button", { name: "Start inspection" }).click();
  await dp
    .getByRole("button", { name: "This is the vehicle I am inspecting" })
    .click();
  await expect(dp.getByTestId("inspection-item")).toHaveCount(20);
  await answerChecklist(dp, {
    firstItemDefect: "Cut on the left front sidewall",
  });
  await dp.getByRole("button", { name: "Next", exact: true }).click();

  // defect photo: the first-use notice, then the camera
  await expect(dp.getByTestId("defect-photo-slot")).toHaveCount(1);
  await takeCameraPhoto(
    dp,
    dp.getByRole("button", { name: "Take photo of the defect" }),
    { acknowledge: true },
  );
  await expect(
    dp.getByTestId("defect-photo-slot").getByText("Attached"),
  ).toBeVisible();
  await dp.getByRole("button", { name: "Next", exact: true }).click();

  // odometer photo (the notice does not come back)
  await takeCameraPhoto(
    dp,
    dp.getByRole("button", { name: "Take odometer photo" }),
  );
  await expect(
    dp.getByTestId("odometer-step").getByText("Attached"),
  ).toBeVisible();
  await expect(dp.locator('input[type="file"], [capture]')).toHaveCount(0);
  await dp.getByRole("button", { name: "Next", exact: true }).click();

  await expect(dp.getByTestId("review-step")).toContainText(
    "Everything is in place",
  );
  await dp.getByRole("button", { name: "Submit inspection" }).click();
  await expect(dp.getByTestId("inspection-submitted")).toContainText(
    "Inspection submitted — the vehicle is now in use.",
  );
  // Tyres is a safety-critical item: the defect is reported plainly and never blocks (and it is not late)
  await expect(dp.getByTestId("safety-notice")).toContainText(
    "Safety defect reported — your supervisor has been told.",
  );
  await expect(dp.getByTestId("late-notice")).toHaveCount(0);
  await dp
    .getByTestId("inspection-submitted")
    .getByRole("link", { name: "Back to my allocations" })
    .click();
  await expect(
    dp
      .getByTestId("my-allocation")
      .filter({ hasText: s.fleet })
      .getByTestId("allocation-status"),
  ).toHaveText("In use");

  // the evidence the server kept (service role = test infrastructure only)
  const { data: files } = await s.sa
    .from("evidence_files")
    .select(
      "capture_source, purpose, width, height, mime_type, exif_gps_stripped, device_id, device_capture_at",
    )
    .eq("uploaded_by", s.driverProfileId);
  expect(files).toHaveLength(2);
  for (const f of files!) {
    expect(f.capture_source).toBe("in_app_camera");
    expect(f.mime_type).toBe("image/jpeg");
    expect(Math.max(f.width!, f.height!)).toBeLessThanOrEqual(1600);
    expect(f.exif_gps_stripped).toBe(true);
    expect(f.device_id).not.toBeNull();
    expect(f.device_capture_at).not.toBeNull();
  }
  expect(files!.map((f) => f.purpose).sort()).toEqual([
    "inspection",
    "odometer",
  ]);
  const { data: insp } = await s.sa
    .from("inspections")
    .select("id, status, device_flag, late_flag, safety_defect_flag")
    .eq("allocation_id", s.allocationId)
    .eq("inspection_stage", "pre_shift")
    .single();
  expect(insp).toMatchObject({
    status: "submitted",
    device_flag: "issued_device",
    late_flag: false,
    safety_defect_flag: true,
  });

  // --- supervisor reads it back
  await ap.goto(`/shifts/inspections?branch=${s.branchId}&date=${s.day}`);
  await ap
    .getByTestId("inspection-row")
    .filter({ hasText: s.fleet })
    .first()
    .getByRole("link")
    .click();
  await expect(ap.getByTestId("inspection-badges")).toContainText(
    "Issued phone",
  );
  await expect(ap.getByTestId("inspection-badges")).toContainText(
    "Safety defect",
  );
  await expect(
    ap.getByText("Cut on the left front sidewall").first(),
  ).toBeVisible();
  await expect(ap.getByText("Phone time, not verified")).toBeVisible();
  const odo = ap
    .getByTestId("evidence-photo")
    .filter({ hasText: "Odometer photo (current)" });
  await odo.getByRole("button", { name: "Show photo" }).click();
  await expect(odo.getByRole("img")).toBeVisible();
  await odo.getByRole("button", { name: "Show photo location" }).click();
  await expect(odo.getByTestId("photo-location")).toContainText("-26.2041");
  const { count: viewed } = await s.sa
    .from("evidence_access_log")
    .select("id", { count: "exact", head: true })
    .eq("access_type", "location_viewed");
  expect(viewed).toBeGreaterThanOrEqual(1);

  // --- end the shift (C2 confirmation) and the post-shift inspection
  await dp.goto("/my-allocations");
  const card2 = dp.getByTestId("my-allocation").filter({ hasText: s.fleet });
  await card2
    .getByRole("link", { name: "End shift — post-shift inspection" })
    .click();
  await expect(dp.getByTestId("end-shift-confirm")).toContainText(
    "This ends your use of",
  );
  await dp.getByRole("button", { name: "Start post-shift inspection" }).click();
  await dp
    .getByRole("button", { name: "This is the vehicle I am inspecting" })
    .click();
  await answerChecklist(dp);
  await dp.getByRole("button", { name: "Next", exact: true }).click(); // no defects: straight to the odometer
  await takeCameraPhoto(
    dp,
    dp.getByRole("button", { name: "Take odometer photo" }),
  );
  await dp.getByRole("button", { name: "Next", exact: true }).click();
  await dp.getByRole("button", { name: "Submit inspection" }).click();
  await expect(dp.getByTestId("inspection-submitted")).toContainText(
    "Post-shift inspection submitted.",
  );
  await dp
    .getByTestId("inspection-submitted")
    .getByRole("link", { name: "Back to my allocations" })
    .click();
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
  expect(alloc!.status).toBe("post_inspection_pending"); // closure is Phase 5

  await dctx.close();
  await actx.close();
});
