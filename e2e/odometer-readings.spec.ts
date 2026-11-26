import {
  devices,
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { signInStaff } from "../tests/integration/helpers";
import {
  answerChecklist,
  branchStaff,
  driverScenario,
  driverSignIn,
  enterReading,
  PIN,
  staffSignIn,
  takeCameraPhoto,
} from "./scenario";

// Slice 5A (DEC-05, DEC-06 / DEC-43, DEC-24, DEC-44) end to end. The driver is on a Pixel 5 with Chromium's fake camera; the reviewer is on a
// tablet-sized viewport. Needs local Supabase (E2E_AUTH=1, as in CI).
//   (a) the driver completes a pre-shift inspection with photo and reading OFFLINE, comes back online and the queue sends it; a different
//       supervisor accepts it in the quick check with ONE tap together with a second reading; the driver sees "Accepted".
//   (b) a post-shift reading lower than the pre-shift reading lands in full review as "Decreasing reading"; a supervisor who completed
//       nothing accepts a different value with a reason; the driver's value is still the one entered; the exception is resolved.
//   (c) the allocation's own driver, given supervisor rights in a fixture, cannot decide their reading: the list says so and the database
//       refuses a direct call (OD006). A different supervisor sees the decision form.
test.skip(process.env.E2E_AUTH !== "1", "requires local Supabase (E2E_AUTH=1)");

const phone = {
  ...devices["Pixel 5"],
  permissions: ["camera", "geolocation"] as string[],
  geolocation: { latitude: -26.2041, longitude: 28.0473 },
};
const tablet = {
  viewport: { width: 1024, height: 768 },
  hasTouch: true,
  permissions: ["camera", "geolocation"] as string[],
  geolocation: { latitude: -26.2041, longitude: 28.0473 },
};
const SLOW = { timeout: 180_000 };
type Scenario = Awaited<ReturnType<typeof driverScenario>>;
const next = (p: Page) =>
  p.getByRole("button", { name: "Next", exact: true }).click();

/** The driver: open the pre-shift form, answer everything "fine", photo, reading, review, submit. Returns the open phone. */
async function completePre(
  browser: Browser,
  s: Scenario,
  km: number,
  opts: { offline: boolean },
): Promise<{ ctx: BrowserContext; dp: Page }> {
  const ctx = await browser.newContext(phone);
  const dp = await ctx.newPage();
  await driverSignIn(dp, s.emp);
  await dp.goto("/my-allocations");
  await dp
    .getByTestId("my-allocation")
    .filter({ hasText: s.fleet })
    .getByTestId("pre-shift-inspection-link")
    .click();
  await expect(
    dp.getByRole("button", { name: "Start inspection" }),
  ).toBeVisible(SLOW);
  if (opts.offline) await ctx.setOffline(true);
  await dp.getByRole("button", { name: "Start inspection" }).click();
  await dp
    .getByRole("button", { name: "This is the vehicle I am inspecting" })
    .click();
  await dp.getByRole("button", { name: "I have checked this list" }).click();
  await answerChecklist(dp);
  await next(dp); // no defects: straight to the odometer
  await takeCameraPhoto(
    dp,
    dp.getByRole("button", { name: "Take odometer photo" }),
    { acknowledge: true },
  );
  // DEC-05: a plain numeric field, blind; nothing on the page shows any machine-read value
  const field = dp.getByLabel("Odometer reading (km)");
  await expect(field).toHaveAttribute("inputmode", "numeric");
  await field.fill("12abc");
  await expect(field).toHaveValue("12"); // digits only
  await enterReading(dp, km);
  await expect(dp.getByTestId("odometer-step")).not.toContainText(/ocr/i);
  await next(dp);
  await expect(dp.getByTestId("review-reading")).toContainText(String(km));
  await expect(dp.getByTestId("review-step")).toContainText(
    "Everything is in place",
  );
  await dp.getByRole("button", { name: "Submit inspection" }).click();
  if (opts.offline) {
    await expect(dp.getByTestId("inspection-queued")).toContainText(
      /saved on this phone/i,
    );
    // nothing reached the server while offline
    const { count } = await s.sa
      .from("odometer_readings")
      .select("id", { count: "exact", head: true })
      .eq("allocation_id", s.allocationId);
    expect(count).toBe(0);
    await ctx.setOffline(false);
  }
  await expect(dp.getByTestId("inspection-submitted")).toBeVisible(SLOW);
  return { ctx, dp };
}

async function reviewer(
  browser: Browser,
  user: { email: string; password: string },
) {
  const ctx = await browser.newContext(tablet);
  const page = await ctx.newPage();
  await staffSignIn(page, user);
  return page;
}

const readingOf = async (s: Scenario, stage: "pre_shift" | "post_shift") =>
  (
    await s.sa
      .from("odometer_readings")
      .select(
        "id, reading_status, review_kind, acceptance_method, driver_reading_km, accepted_reading_km, captured_offline, validation, approval_id",
      )
      .eq("allocation_id", s.allocationId)
      .eq("inspection_stage", stage)
      .single()
  ).data!;

// ================================================================================================================ (a)
test("(a) pre-shift reading entered offline is sent; a different supervisor accepts it with a second reading in one tap; the driver sees Accepted", async ({
  browser,
}) => {
  test.setTimeout(600_000);
  const s1 = await driverScenario({
    tag: "RA",
    status: "pre_inspection_pending",
  });
  const s2 = await driverScenario({
    tag: "RB",
    status: "pre_inspection_pending",
  });
  const sup = await branchStaff(s1, "ra-sup", "supervisor");

  const d1 = await completePre(browser, s1, 12345, { offline: true });
  const d2 = await completePre(browser, s2, 22222, { offline: false });

  const r1 = await readingOf(s1, "pre_shift");
  expect(r1).toMatchObject({
    reading_status: "awaiting_review",
    review_kind: "quick_check",
    driver_reading_km: 12345,
    captured_offline: true,
  });
  expect(JSON.stringify(r1.validation)).not.toMatch(/ocr/i);
  // the driver sees the plain status, never a reviewer
  await expect(d1.dp.getByTestId("reading-status")).toContainText(
    "Reading sent for checking",
  );

  const sp = await reviewer(browser, sup);
  await sp.goto(`/odometer/review?tab=quick_check&branch=${s1.branchId}`);
  const c1 = sp.getByTestId("quick-card").filter({ hasText: s1.fleet });
  const c2 = sp.getByTestId("quick-card").filter({ hasText: s2.fleet });
  await expect(c1.getByTestId("typed-reading")).toHaveAttribute(
    "data-km",
    "12345",
  );
  await expect(c2.getByTestId("typed-reading")).toHaveAttribute(
    "data-km",
    "22222",
  );
  await expect(c1.getByTestId("reading-photo")).toBeVisible(SLOW); // through the signed-URL path (logged)
  await expect(c1.getByTestId("previous-reading")).toContainText(
    "No earlier accepted reading",
  );
  // implausible distance is not configured: shown as a neutral note, not a failure
  await expect(c1.getByTestId("neutral-notes")).toHaveCount(0); // pre-shift has no implausible-distance check
  await c1.getByLabel(/Select the reading of .* to accept/).check();
  await c2.getByLabel(/Select the reading of .* to accept/).check();
  await sp.getByTestId("accept-selected").click();
  await expect(sp.getByTestId("quick-check-result")).toContainText(
    "2 readings accepted.",
    SLOW,
  );

  for (const [s, km] of [
    [s1, 12345],
    [s2, 22222],
  ] as const) {
    const r = await readingOf(s, "pre_shift");
    expect(r).toMatchObject({
      reading_status: "accepted",
      acceptance_method: "reviewer",
      review_kind: "quick_check",
      driver_reading_km: km,
      accepted_reading_km: km,
    });
  }
  // the driver sees "Accepted" (never who accepted it)
  await d1.dp.goto(`/my-allocations/${s1.allocationId}/inspection/pre_shift`);
  await expect(d1.dp.getByTestId("reading-status")).toContainText(
    "Accepted",
    SLOW,
  );
  await expect(d1.dp.getByTestId("reading-status")).not.toContainText(
    sup.email,
  );
  await d2.ctx.close();
});

// ================================================================================================================ (b)
test("(b) a post-shift reading lower than the pre-shift reading goes to full review; a different supervisor accepts another value with a reason", async ({
  browser,
}) => {
  test.setTimeout(600_000);
  const s = await driverScenario({
    tag: "RC",
    status: "pre_inspection_pending",
  });
  const sup = await branchStaff(s, "rc-sup", "supervisor");
  const d = await completePre(browser, s, 2000, { offline: false });
  const sp = await reviewer(browser, sup);

  // the pre-shift reading is accepted in the quick check
  await sp.goto(`/odometer/review?tab=quick_check&branch=${s.branchId}`);
  const pre = sp.getByTestId("quick-card").filter({ hasText: s.fleet });
  await pre.getByLabel(/Select the reading of .* to accept/).check();
  await sp.getByTestId("accept-selected").click();
  await expect(sp.getByTestId("quick-check-result")).toContainText(
    "1 reading accepted.",
    SLOW,
  );

  // the driver ends the shift and enters a LOWER post-shift reading
  const dp = d.dp;
  await dp.goto("/my-allocations");
  await dp
    .getByTestId("my-allocation")
    .filter({ hasText: s.fleet })
    .getByRole("link", { name: "End shift — post-shift inspection" })
    .click();
  await dp.getByRole("button", { name: "Start post-shift inspection" }).click();
  await dp
    .getByRole("button", { name: "This is the vehicle I am inspecting" })
    .click();
  await dp.getByRole("button", { name: "I have checked this list" }).click();
  await answerChecklist(dp);
  await next(dp);
  await takeCameraPhoto(
    dp,
    dp.getByRole("button", { name: "Take odometer photo" }),
  );
  await enterReading(dp, 1900);
  await next(dp);
  await dp.getByRole("button", { name: "Submit inspection" }).click();
  await expect(dp.getByTestId("inspection-submitted")).toBeVisible(SLOW);
  await expect(dp.getByTestId("reading-status")).toContainText(
    "Needs a supervisor",
  );

  const post = await readingOf(s, "post_shift");
  expect(post).toMatchObject({
    reading_status: "awaiting_review",
    review_kind: "full",
    driver_reading_km: 1900,
  });

  // full review: the failed check is named, the typed value is shown as entered
  await sp.goto(`/odometer/review?tab=full&branch=${s.branchId}`);
  const row = sp.getByTestId("full-review-row").filter({ hasText: s.fleet });
  await expect(row).toContainText("Decreasing reading");
  await row.getByRole("link", { name: "Review" }).click();
  await expect(sp.getByTestId("typed-reading")).toHaveAttribute(
    "data-km",
    "1900",
  );
  await expect(
    sp.locator('[data-check="decreasing_reading"][data-result="fail"]'),
  ).toBeVisible();
  await expect(sp.getByTestId("previous-reading")).toContainText("2000 km");
  await sp
    .getByLabel("Accept a different value (what the photo shows)")
    .check();
  await sp.getByLabel("Reading shown in the photo (km)").fill("2005");
  await sp.getByLabel(/^Reason \(required\)/).fill("The photo shows 2005 km");
  await sp.getByRole("button", { name: "Save decision" }).click();
  await expect(sp.getByTestId("decision-message")).toContainText(
    "The reading was accepted.",
    SLOW,
  );

  const done = await readingOf(s, "post_shift");
  expect(done).toMatchObject({
    reading_status: "accepted",
    review_kind: "full",
    acceptance_method: "reviewer",
    driver_reading_km: 1900, // never edited
    accepted_reading_km: 2005,
  });
  const { data: ex } = await s.sa
    .from("odometer_exceptions")
    .select("exception_type, status, approval_id")
    .eq("odometer_reading_id", done.id);
  expect(ex!.length).toBeGreaterThan(0);
  for (const e of ex!) {
    expect(e.status).toBe("resolved");
    expect(e.approval_id).toBe(done.approval_id);
  }
  const { data: appr } = await s.sa
    .from("approvals")
    .select("approval_type, status, requested_by, decided_by")
    .eq("id", done.approval_id!)
    .single();
  expect(appr).toMatchObject({
    approval_type: "odometer_exception",
    status: "approved",
    requested_by: s.driverProfileId,
  });
  expect(appr!.decided_by).toBe(sup.id);
  // the driver still sees the value they typed, now accepted
  await dp.goto(`/my-allocations/${s.allocationId}/inspection/post_shift`);
  await expect(dp.getByTestId("reading-status")).toContainText(/1\D?900/);
  await expect(dp.getByTestId("reading-status")).toContainText(
    "Accepted",
    SLOW,
  );
});

// ================================================================================================================ (c)
test("(c) the allocation's own driver, given supervisor rights in a fixture, cannot decide their reading: the list says so and the database refuses a direct call", async ({
  browser,
}) => {
  test.setTimeout(600_000);
  // planned start 45 minutes ago: the inspection is late (DEC-17), so the reading goes to full review
  const s = await driverScenario({
    tag: "RD",
    status: "pre_inspection_pending",
    startedMinutesAgo: 45,
  });
  await completePre(browser, s, 3000, { offline: false });
  const mine = await readingOf(s, "pre_shift");
  expect(mine).toMatchObject({
    reading_status: "awaiting_review",
    review_kind: "full",
  });

  // fixture: the driver also holds the supervisor role; an authenticator makes the session AAL2 so the permission is live
  const { grant } = await import("../tests/integration/helpers");
  await grant(s.w, s.driverProfileId, "supervisor", s.branchId, s.bootId);
  const login = (
    await s.sa
      .from("profiles")
      .select("login_identifier")
      .eq("id", s.driverProfileId)
      .single()
  ).data!.login_identifier;
  const own = await signInStaff(login, PIN, "enrol");

  const list = await own.rpc("list_odometer_review", {
    p_queue: "full",
    p_branch_id: s.branchId,
  });
  expect(list.error).toBeNull();
  const row = list.data!.find((r) => r.reading_id === mine.id)!;
  expect(row).toBeTruthy(); // they may look...
  expect(row.can_decide).toBe(false); // ...but not decide
  expect(row.blocked_reason).toMatch(
    /cannot check or decide a reading you entered/,
  );

  const direct = await own.rpc("review_reading", {
    p_reading_id: mine.id,
    p_decision: "accept",
    p_accepted_km: null as unknown as number,
    p_reason: "It is my own reading",
    p_client_submission_id: crypto.randomUUID(),
  });
  expect(direct.error?.code).toBe("OD006");
  const batch = await own.rpc("quick_check_accept", {
    p_items: [{ reading_id: mine.id, validated_at: new Date().toISOString() }],
    p_client_submission_id: crypto.randomUUID(),
  });
  const res = (batch.data as { results: { result: string; code?: string }[] })
    .results[0]!;
  expect(res).toMatchObject({ result: "refused", code: "OD006" });
  expect((await readingOf(s, "pre_shift")).reading_status).toBe(
    "awaiting_review",
  ); // nothing changed

  // a different supervisor sees the decision form for the same reading
  const other = await branchStaff(s, "rd-sup", "supervisor");
  const op = await reviewer(browser, other);
  await op.goto(`/odometer/review/${mine.id}`);
  await expect(op.getByTestId("decision-form")).toBeVisible(SLOW);
  await expect(op.getByTestId("cannot-decide")).toHaveCount(0);
});
