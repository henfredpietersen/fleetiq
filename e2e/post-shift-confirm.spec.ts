import { expect, test } from "@playwright/test";
import { driverScenario, driverSignIn } from "./scenario";

// Slice 4B carry-over C2: beginning the post-shift inspection ends the driver's use of the vehicle, so the driver confirms
// first. Cancel leaves everything unchanged; Confirm starts it. Needs local Supabase + synthetic data (E2E_AUTH=1, as in CI).
test.skip(process.env.E2E_AUTH !== "1", "requires local Supabase (E2E_AUTH=1)");

test("end shift asks first: Cancel changes nothing, confirming starts the post-shift inspection", async ({
  page,
}) => {
  const s = await driverScenario({ tag: "C2", status: "in_use" });
  await driverSignIn(page, s.emp);
  await page.goto("/my-allocations");
  const card = page.getByTestId("my-allocation").filter({ hasText: s.fleet });
  await expect(card.getByTestId("allocation-status")).toHaveText("In use");

  // Cancel
  await card
    .getByRole("link", { name: "End shift — post-shift inspection" })
    .click();
  const confirm = page.getByTestId("end-shift-confirm");
  await expect(confirm).toContainText("Start the post-shift inspection?");
  await expect(confirm).toContainText(`This ends your use of ${s.fleet} / `);
  await expect(confirm).toContainText(
    "You cannot go back to driving it on this allocation.",
  );
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(page).toHaveURL(/\/my-allocations$/);
  const after = page.getByTestId("my-allocation").filter({ hasText: s.fleet });
  await expect(after.getByTestId("allocation-status")).toHaveText("In use");
  const { data: unchanged } = await s.sa
    .from("vehicle_allocations")
    .select("status")
    .eq("id", s.allocationId)
    .single();
  expect(unchanged!.status).toBe("in_use");
  const { count } = await s.sa
    .from("inspections")
    .select("id", { count: "exact", head: true })
    .eq("allocation_id", s.allocationId);
  expect(count).toBe(0);

  // Confirm
  await after
    .getByRole("link", { name: "End shift — post-shift inspection" })
    .click();
  await page
    .getByTestId("end-shift-confirm")
    .getByRole("button", { name: "Start post-shift inspection" })
    .click();
  // the draft opens on "confirm the vehicle", then the checklist
  await page
    .getByRole("button", { name: "This is the vehicle I am inspecting" })
    .click();
  await page.getByRole("button", { name: "I have checked this list" }).click();
  await expect(page.getByTestId("inspection-item").first()).toBeVisible();
  const { data: moved } = await s.sa
    .from("vehicle_allocations")
    .select("status")
    .eq("id", s.allocationId)
    .single();
  expect(moved!.status).toBe("post_inspection_pending");
});
