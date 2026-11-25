import { devices, expect, test } from "@playwright/test";
import { anonClient, totp } from "../tests/integration/helpers";
import {
  answerChecklist,
  branchStaff,
  driverScenario,
  driverSignIn,
  enterReading,
  staffSignIn,
  takeCameraPhoto,
} from "./scenario";

// Slice 4C (DEC-42) end to end on a Pixel 5 with Chromium's fake camera. (a) A supervisor records existing damage with a photo
// ("onboarding"); the driver sees it in the pre-shift list, reports ONE new damage with a photo, confirms the list, submits and sees
// the neutral message; the supervisor sees the New damage badge and the interval; a DIFFERENT reviewer verifies the new damage, and
// the person who reported an item can neither see the button nor do it (the database refuses it too). Needs local Supabase
// (E2E_AUTH=1, as in CI).
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

test("onboarding damage, driver reports new damage, supervisor sees the interval, a different reviewer verifies", async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const s = await driverScenario({
    tag: "DM",
    status: "pre_inspection_pending",
  });
  const sup1 = await branchStaff(s, "dmg-sup1", "supervisor");
  const sup2 = await branchStaff(s, "dmg-sup2", "supervisor");

  // --- supervisor 1 records the vehicle's existing damage (day-one load), photo from the in-app camera
  const c1 = await browser.newContext(desk);
  const p1 = await c1.newPage();
  const sup1Secret = await staffSignIn(p1, sup1);
  await p1.goto(`/vehicles/${s.vehicleId}/damage`);
  await expect(p1.locator('input[type="file"], [capture]')).toHaveCount(0); // no file picker anywhere (DEC-04/41)
  await p1.getByRole("button", { name: "Record existing damage" }).click();
  await p1.getByLabel("Where on the vehicle?").selectOption("left_front");
  await p1.getByRole("radio", { name: "Minor" }).click();
  await p1
    .getByLabel("What does it look like?")
    .fill("Old scratch on the left front door");
  await takeCameraPhoto(
    p1,
    p1.getByRole("button", { name: "Take a photo of the damage" }),
    { acknowledge: true },
  );
  await expect(
    p1.getByTestId("damage-reporter").getByText("Attached", { exact: true }),
  ).toBeVisible();
  await p1.getByRole("button", { name: "Record this damage" }).click();
  await expect(p1.getByText("Existing damage recorded.")).toBeVisible();
  const onboard = p1
    .getByTestId("damage-item")
    .filter({ hasText: "Old scratch on the left front door" });
  await expect(onboard).toContainText("Left front (door and wing)");
  await expect(onboard.getByTestId("damage-status")).toHaveText("Reported");
  // the reporter can never review their own report: no button, and the database refuses it as well
  await expect(onboard).toContainText("Reported by you");
  await expect(onboard.getByRole("button", { name: "Verify" })).toHaveCount(0);
  const { data: ob } = await s.sa
    .from("vehicle_damage_items")
    .select("id, source, status")
    .eq("vehicle_id", s.vehicleId)
    .single();
  expect(ob).toMatchObject({ source: "onboarding", status: "reported" });
  // a real AAL2 staff session on the authenticator the UI just enrolled (DEC-34): without it the refusal would be a permission
  // one, not the DEC-24 one
  const as1 = anonClient();
  expect(
    (
      await as1.auth.signInWithPassword({
        email: sup1.email,
        password: sup1.password,
      })
    ).error,
  ).toBeNull();
  const factor = (await as1.auth.mfa.listFactors()).data!.totp[0]!;
  const challenge = (await as1.auth.mfa.challenge({ factorId: factor.id }))
    .data!;
  expect(
    (
      await as1.auth.mfa.verify({
        factorId: factor.id,
        challengeId: challenge.id,
        code: totp(sup1Secret),
      })
    ).error,
  ).toBeNull();
  const own = await as1.rpc("review_damage", {
    p_item_id: ob!.id,
    p_decision: "verified",
    p_reason: "",
    p_client_submission_id: crypto.randomUUID(),
  });
  expect(own.error?.message).toContain(
    "You cannot review damage you reported yourself",
  );

  // --- the driver: pre-shift inspection, the known damage list, one new damage report with a photo
  const dctx = await browser.newContext(phone);
  const dp = await dctx.newPage();
  await driverSignIn(dp, s.emp);
  await dp.goto("/my-allocations");
  await dp
    .getByTestId("my-allocation")
    .filter({ hasText: s.fleet })
    .getByTestId("pre-shift-inspection-link")
    .click();
  await dp.getByRole("button", { name: "Start inspection" }).click();
  await dp
    .getByRole("button", { name: "This is the vehicle I am inspecting" })
    .click();
  const known = dp.getByTestId("known-damage-item");
  await expect(known).toHaveCount(1);
  await expect(known).toContainText("Old scratch on the left front door");
  await expect(known).toContainText("Left front (door and wing)");
  await expect(dp.getByTestId("damage-step").getByRole("img")).toHaveCount(0); // other people's photos are not shown
  await dp.getByRole("button", { name: "Report new damage" }).click();
  await dp.getByLabel("Where on the vehicle?").selectOption("front_bumper");
  await dp.getByRole("radio", { name: "Moderate" }).click();
  await dp
    .getByLabel("What does it look like?")
    .fill("Dent in the front bumper");
  await expect(
    dp.getByRole("button", { name: "Report this damage" }),
  ).toBeDisabled(); // no photo yet
  await takeCameraPhoto(
    dp,
    dp.getByRole("button", { name: "Take a photo of the damage" }),
    { acknowledge: true },
  );
  // in an inspection the photo is kept on the phone and goes with the report through the queue (DEC-06)
  await expect(
    dp
      .getByTestId("damage-reporter")
      .getByText("Saved on this phone", { exact: true }),
  ).toBeVisible();
  await dp.getByRole("button", { name: "Report this damage" }).click();
  await expect(known).toHaveCount(2);
  await expect(dp.getByText("Reported now", { exact: true })).toBeVisible();
  await dp.getByRole("button", { name: "I have checked this list" }).click();
  await answerChecklist(dp);
  await dp.getByRole("button", { name: "Next", exact: true }).click(); // no defects: straight to the odometer
  await takeCameraPhoto(
    dp,
    dp.getByRole("button", { name: "Take odometer photo" }),
  );
  await enterReading(dp, 12345); // 5A: the driver types the reading shown in the photo (DEC-05)
  await expect(
    dp.getByTestId("odometer-step").getByText("Attached", { exact: true }),
  ).toBeVisible();
  await dp.getByRole("button", { name: "Next", exact: true }).click();
  await expect(dp.getByTestId("review-new-damage")).toContainText(
    "Dent in the front bumper",
  );
  await expect(dp.getByTestId("review-step")).toContainText(
    "Everything is in place",
  );
  await dp.getByRole("button", { name: "Submit inspection" }).click();
  await expect(dp.getByTestId("inspection-submitted")).toContainText(
    "Inspection submitted — the vehicle is now in use.",
  );
  const notice = dp.getByTestId("new-damage-notice");
  await expect(notice).toHaveText(
    "New damage recorded — your supervisor will review it.",
  );
  await expect(notice).not.toContainText(/fault|blame|liable|responsible/i); // no wording that suggests blame

  // --- supervisor 1: the New damage badge, the filter and the interval
  await p1.goto(
    `/shifts/inspections?branch=${s.branchId}&date=${s.day}&newdamage=1`,
  );
  const row = p1.getByTestId("inspection-row").filter({ hasText: s.fleet });
  await expect(row).toContainText("New damage");
  await row.getByRole("link").click();
  await expect(p1.getByTestId("new-damage-badge")).toBeVisible();
  const item = p1.getByTestId("new-damage-item");
  await expect(item).toContainText("Dent in the front bumper");
  await expect(item.getByTestId("damage-interval")).toHaveText(
    "No previous post-shift inspection.",
  );
  await item.getByRole("button", { name: "Show photo", exact: true }).click();
  await expect(item.getByRole("img")).toBeVisible();
  const { data: flag } = await s.sa
    .from("inspections")
    .select("new_damage_flag, known_damage_reviewed")
    .eq("allocation_id", s.allocationId)
    .eq("inspection_stage", "pre_shift")
    .single();
  expect(flag).toEqual({ new_damage_flag: true, known_damage_reviewed: true });

  // --- a DIFFERENT reviewer verifies the driver's report (and the onboarding item)
  const c2 = await browser.newContext(desk);
  const p2 = await c2.newPage();
  await staffSignIn(p2, sup2);
  await p2.goto(`/vehicles/${s.vehicleId}/damage`);
  const dent = p2
    .getByTestId("damage-item")
    .filter({ hasText: "Dent in the front bumper" });
  await dent.getByRole("button", { name: "Verify" }).click();
  await dent.getByRole("button", { name: "Verify" }).click(); // the form's submit (note is optional)
  await expect(dent.getByTestId("damage-status")).toHaveText("Verified");
  const scratch = p2
    .getByTestId("damage-item")
    .filter({ hasText: "Old scratch on the left front door" });
  await scratch.getByRole("button", { name: "Dispute" }).click();
  await scratch
    .getByLabel("Reason for disputing (required)")
    .fill("Already repaired in the workshop");
  await scratch.getByRole("button", { name: "Dispute" }).click();
  await expect(scratch.getByTestId("damage-status")).toHaveText("Disputed");
  await expect(scratch.getByRole("button", { name: "Verify" })).toHaveCount(0); // disputed is final

  const { data: items } = await s.sa
    .from("vehicle_damage_items")
    .select(
      "status, source, reported_stage, interval_previous_allocation_id, reviewed_by, reported_by",
    )
    .eq("vehicle_id", s.vehicleId)
    .order("source");
  expect(items!.map((i) => `${i.source}/${i.status}`).sort()).toEqual([
    "inspection/verified",
    "onboarding/disputed",
  ]);
  for (const i of items!) expect(i.reviewed_by).toBe(sup2.id); // never the reporter
  expect(items!.find((i) => i.source === "inspection")).toMatchObject({
    reported_stage: "pre_shift",
    interval_previous_allocation_id: null,
    reported_by: s.driverProfileId,
  });

  await c1.close();
  await c2.close();
  await dctx.close();
});
