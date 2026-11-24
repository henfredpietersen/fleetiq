import { devices, expect, test } from "@playwright/test";
import { driverScenario, driverSignIn } from "./scenario";

// Slice 4B: when the camera cannot be used the driver is told so plainly and there is NEVER a file picker or gallery to fall
// back on (DEC-04, DEC-41). Permission denial is simulated in the page (the project's fake-UI flag would auto-accept it).
test.skip(process.env.E2E_AUTH !== "1", "requires local Supabase (E2E_AUTH=1)");

test("camera permission denied: the camera-needed message, call the supervisor, no file picker", async ({
  browser,
}) => {
  const s = await driverScenario({
    tag: "D",
    status: "pre_inspection_pending",
  });
  const ctx = await browser.newContext({ ...devices["Pixel 5"] });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: () =>
          Promise.reject(
            new DOMException("Permission denied", "NotAllowedError"),
          ),
      },
    });
  });
  const page = await ctx.newPage();
  await driverSignIn(page, s.emp);
  await page.goto(`/my-allocations/${s.allocationId}/inspection/pre-shift`);
  await page.getByRole("button", { name: "Start inspection" }).click();
  await page
    .getByRole("button", { name: "This is the vehicle I am inspecting" })
    .click();
  await page.getByRole("button", { name: "Next", exact: true }).click(); // checklist -> odometer
  await page.getByRole("button", { name: "Take odometer photo" }).click();

  const cam = page.getByTestId("camera");
  // declining the notice never blocks the attempt
  await cam.getByRole("button", { name: "Not now" }).click();
  const msg = page.getByTestId("camera-unavailable");
  await expect(msg).toBeVisible();
  await expect(msg).toContainText("needs the phone camera");
  await expect(msg).toContainText("call your supervisor");
  await expect(page.locator('input[type="file"], [capture]')).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /gallery|choose|upload|browse/i }),
  ).toHaveCount(0);

  // the notice was declined, not acknowledged: nothing recorded
  const { count } = await s.sa
    .from("camera_notice_acknowledgements")
    .select("id", { count: "exact", head: true })
    .eq("profile_id", s.driverProfileId);
  expect(count).toBe(0);
  // and no photo exists
  const { count: files } = await s.sa
    .from("evidence_files")
    .select("id", { count: "exact", head: true })
    .eq("uploaded_by", s.driverProfileId);
  expect(files).toBe(0);
  await ctx.close();
});
