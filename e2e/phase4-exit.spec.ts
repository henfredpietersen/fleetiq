import {
  devices,
  expect,
  test,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { E2E_COMPANY_ID } from "./global-setup";
import {
  answerChecklist,
  branchStaff,
  driverScenario,
  driverSignIn,
  enterReading,
  staffSignIn,
  takeCameraPhoto,
} from "./scenario";
import { admin } from "../tests/integration/helpers";
import {
  enqueueInspectionWatch,
  inspectionWatchHandler,
  INSPECTION_WATCH_JOB,
} from "../src/jobs/inspection-watch";
import { runDueJobs } from "../src/jobs/worker";

// Phase 4 exit test (PRD v1.18 §9; DEC-06, DEC-40, DEC-43) on a Pixel 5 with Chromium's fake camera. Every spec really runs in CI (E2E_AUTH=1).
//   (a) weak connection: the whole run is throttled (CDP, ~400 kbps down / 150 kbps up / 400 ms). Start online, go offline, complete
//       the whole pre-shift inspection, submit ("saved on this phone"), back online: the queue sends it all in order, the allocation is
//       In use and the inspection is captured_offline; then the post-shift inspection offline and sent (awaiting closure).
//   (b) flaky connection: offline/online toggled mid-queue and one request aborted: no duplicate rows, the same client_submission_ids replayed.
//   (c) conflict: a supervisor cancels the allocation while the phone is offline; the queue stops with the server's message, the conflict
//       shows on the Missing / Late page, a DIFFERENT supervisor resolves it, then the driver removes the items from the phone.
//   (d) detection: planned start + 31 min with no pre-shift inspection is on the Missing / Late page; the job records ONE finding (also
//       when run twice); submitting resolves it.
//   (e) sign-out with queued items warns; the same driver signing back in resumes and sends; another driver on that phone neither
//       sees nor sends the first driver's items.
// Waits are on the queue's own state (banner, status lines, the database), never on sleeps. Needs local Supabase (E2E_AUTH=1, as in CI).
test.skip(process.env.E2E_AUTH !== "1", "requires local Supabase (E2E_AUTH=1)");

const phone = {
  ...devices["Pixel 5"],
  permissions: ["camera", "geolocation"] as string[],
  geolocation: { latitude: -26.2041, longitude: 28.0473 },
};
const SLOW = { timeout: 180_000 };
const SYNC = "**/api/inspection-sync";

type Scenario = Awaited<ReturnType<typeof driverScenario>>;

// ---------------------------------------------------------------- the phone's connection
/**
 * context.setOffline() and the CDP throttle both drive Network.emulateNetworkConditions, so going back online re-applies the throttle:
 * the run stays at "weak" whenever the phone is online.
 */
class Connection {
  private cdp: Awaited<ReturnType<BrowserContext["newCDPSession"]>> | null =
    null;
  constructor(
    private ctx: BrowserContext,
    private page: Page,
    private weak: boolean,
  ) {}
  async apply() {
    if (!this.weak) return;
    this.cdp ??= await this.ctx.newCDPSession(this.page);
    await this.cdp.send("Network.enable");
    await this.cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 400,
      downloadThroughput: (400 * 1024) / 8,
      uploadThroughput: (150 * 1024) / 8,
    });
  }
  async offline() {
    await this.ctx.setOffline(true);
    await expect
      .poll(() => this.page.evaluate(() => navigator.onLine))
      .toBe(false);
  }
  async online() {
    await this.ctx.setOffline(false);
    await this.apply();
    await expect
      .poll(() => this.page.evaluate(() => navigator.onLine))
      .toBe(true);
  }
}

async function phoneFor(
  browser: import("@playwright/test").Browser,
  opts: { weak: boolean },
) {
  const ctx = await browser.newContext(phone);
  const page = await ctx.newPage();
  const conn = new Connection(ctx, page, opts.weak);
  return { ctx, page, conn };
}

/** Every request the phone makes to the queue's endpoint, in order: { op, csid, profileId }. */
function recordSync(page: Page) {
  const seen: { op: string; csid: string | null; profileId: string }[] = [];
  page.on("request", (r) => {
    if (!r.url().endsWith("/api/inspection-sync") || r.method() !== "POST")
      return;
    const b = r.postDataJSON() as {
      op: string;
      clientSubmissionId?: string;
      profileId: string;
    };
    seen.push({
      op: b.op,
      csid: b.clientSubmissionId ?? null,
      profileId: b.profileId,
    });
  });
  return seen;
}

const banner = (p: Page) => p.getByTestId("sync-banner");

async function inspectionRows(s: Scenario, stage: "pre_shift" | "post_shift") {
  const { data, error } = await s.sa
    .from("inspections")
    .select(
      "id, status, captured_offline, late_flag, submitted_by, vehicle_confirmed",
    )
    .eq("allocation_id", s.allocationId)
    .eq("inspection_stage", stage);
  expect(error).toBeNull();
  return data ?? [];
}
const allocationStatus = async (s: Scenario) =>
  (
    await s.sa
      .from("vehicle_allocations")
      .select("status")
      .eq("id", s.allocationId)
      .single()
  ).data!.status;

/** Start inspection -> confirm vehicle -> known damage. (The form is already open.) */
async function openChecklist(p: Page) {
  await p.getByRole("button", { name: "Start inspection" }).click();
  await p
    .getByRole("button", { name: "This is the vehicle I am inspecting" })
    .click();
  await p.getByRole("button", { name: "I have checked this list" }).click();
  await expect(p.getByTestId("inspection-item")).toHaveCount(20);
}
const next = (p: Page) =>
  p.getByRole("button", { name: "Next", exact: true }).click();

// ================================================================================================================ (a)
test("(a) weak connection: start online, the whole pre-shift offline, send in order; then the post-shift offline", async ({
  browser,
}) => {
  test.setTimeout(720_000);
  const s = await driverScenario({ tag: "XA", status: "planned" });
  const { ctx, page: dp, conn } = await phoneFor(browser, { weak: true });
  const sent = recordSync(dp);
  await driverSignIn(dp, s.emp);
  await conn.apply(); // from here to the end the phone is on a weak connection

  // --- start the allocation ONLINE (DEC-40: starting needs a connection)
  await dp.goto("/my-allocations");
  const card = dp.getByTestId("my-allocation").filter({ hasText: s.fleet });
  await card.getByRole("button", { name: "Start" }).click();
  await expect(card.getByTestId("allocation-status")).toHaveText(
    "Pre-inspection pending",
    SLOW,
  );
  await expect(dp.getByTestId("sync-last-updated")).toBeVisible(SLOW); // the 24-hour snapshot is on the phone
  await card.getByTestId("pre-shift-inspection-link").click();
  await expect(
    dp.getByRole("button", { name: "Start inspection" }),
  ).toBeVisible(SLOW);

  // --- offline: no Start button any more, and the whole inspection can still be done
  await conn.offline();
  await expect(banner(dp)).toHaveCount(0); // nothing queued yet
  await openChecklist(dp);
  await expect(banner(dp)).toHaveText("Offline — saved on this phone");
  await answerChecklist(dp, {
    firstItemDefect: "Cut on the left front sidewall",
  });
  await next(dp);
  await expect(dp.getByTestId("defect-photo-slot")).toHaveCount(1);
  await takeCameraPhoto(
    dp,
    dp.getByRole("button", { name: "Take photo of the defect" }),
    { acknowledge: true },
  );
  await expect(
    dp.getByTestId("defect-photo-slot").getByTestId("photo-queued"),
  ).toBeVisible();
  await next(dp);
  await takeCameraPhoto(
    dp,
    dp.getByRole("button", { name: "Take odometer photo" }),
  );
  await enterReading(dp, 12345); // 5A: the driver types the reading shown in the photo (DEC-05)
  await expect(
    dp.getByTestId("odometer-step").getByTestId("photo-queued"),
  ).toBeVisible();
  await next(dp);
  await expect(dp.getByTestId("review-step")).toContainText(
    "Everything is in place",
  );
  await dp.getByRole("button", { name: "Submit inspection" }).click();
  await expect(dp.getByTestId("inspection-queued")).toContainText(
    /saved on this phone/i,
  );
  await expect(banner(dp)).toHaveText("Offline — saved on this phone");
  // nothing reached the server while offline
  expect(await inspectionRows(s, "pre_shift")).toHaveLength(0);

  // --- back online: the queue sends everything, in order
  await conn.online();
  await expect(dp.getByTestId("inspection-submitted")).toBeVisible(SLOW);
  await expect(dp.getByTestId("inspection-submitted")).toContainText(
    "Inspection submitted — the vehicle is now in use.",
  );
  const pre = await inspectionRows(s, "pre_shift");
  expect(pre).toHaveLength(1);
  expect(pre[0]).toMatchObject({ status: "submitted", captured_offline: true });
  expect(await allocationStatus(s)).toBe("in_use");
  const ops = sent.map((x) => x.op).filter((o) => o !== "snapshot");
  expect(ops[0]).toBe("begin");
  expect(ops.at(-1)).toBe("submit");
  // each photo: slot before register before attach; the attaches before the submit; and the draft was begun first
  for (const attach of ["attach_odometer", "attach_defect"]) {
    expect(ops.indexOf("slot")).toBeLessThan(ops.indexOf(attach));
    expect(ops.indexOf(attach)).toBeLessThan(ops.lastIndexOf("submit"));
  }
  const { count: files } = await s.sa
    .from("evidence_files")
    .select("id", { count: "exact", head: true })
    .eq("uploaded_by", s.driverProfileId);
  expect(files).toBe(2);
  await dp.goto("/my-allocations");
  await expect(
    dp
      .getByTestId("my-allocation")
      .filter({ hasText: s.fleet })
      .getByTestId("allocation-status"),
  ).toHaveText("In use", SLOW);

  // --- the post-shift inspection: confirmed online, completed offline, sent when the connection is back
  await dp
    .getByTestId("my-allocation")
    .filter({ hasText: s.fleet })
    .getByRole("link", { name: "End shift — post-shift inspection" })
    .click();
  await expect(dp.getByTestId("end-shift-confirm")).toBeVisible(SLOW);
  await conn.offline();
  await dp.getByRole("button", { name: "Start post-shift inspection" }).click();
  await dp
    .getByRole("button", { name: "This is the vehicle I am inspecting" })
    .click();
  await dp.getByRole("button", { name: "I have checked this list" }).click();
  await answerChecklist(dp);
  await next(dp); // no defects: straight to the odometer
  // (the acknowledgement made offline was recorded once the connection was back: the notice does not come again)
  await takeCameraPhoto(
    dp,
    dp.getByRole("button", { name: "Take odometer photo" }),
  );
  await enterReading(dp, 12345); // 5A: the driver types the reading shown in the photo (DEC-05)
  await next(dp);
  await expect(dp.getByTestId("review-step")).toContainText(
    "Everything is in place",
  );
  await dp.getByRole("button", { name: "Submit inspection" }).click();
  await expect(dp.getByTestId("inspection-queued")).toContainText(
    /saved on this phone/i,
  );
  await conn.online();
  await expect(dp.getByTestId("inspection-submitted")).toBeVisible(SLOW);
  await expect(dp.getByTestId("inspection-submitted")).toContainText(
    "Post-shift inspection submitted.",
  );
  const post = await inspectionRows(s, "post_shift");
  expect(post).toHaveLength(1);
  expect(post[0]).toMatchObject({
    status: "submitted",
    captured_offline: true,
  });
  await dp.goto("/my-allocations");
  await expect(
    dp
      .getByTestId("my-allocation")
      .filter({ hasText: s.fleet })
      .getByTestId("allocation-status"),
  ).toHaveText("Awaiting post-shift closure", SLOW);
  expect(await allocationStatus(s)).toBe("post_inspection_pending"); // closure is Phase 5
  await ctx.close();
});

// ================================================================================================================ (b)
test("(b) flaky connection: toggles and an aborted request leave no duplicate rows and replay the same ids", async ({
  browser,
}) => {
  test.setTimeout(600_000);
  const s = await driverScenario({
    tag: "XB",
    status: "pre_inspection_pending",
  });
  const { ctx, page: dp, conn } = await phoneFor(browser, { weak: false });
  const sent = recordSync(dp);
  await driverSignIn(dp, s.emp);
  // one request is made to fail with an abort: the first attach of the odometer photo
  let aborted: string | null = null;
  await dp.route(SYNC, async (route) => {
    const b = route.request().postDataJSON() as {
      op: string;
      clientSubmissionId?: string;
    };
    if (b.op === "attach_odometer" && aborted === null) {
      aborted = b.clientSubmissionId ?? "";
      await route.abort("failed");
      return;
    }
    await route.continue();
  });

  await dp.goto(`/my-allocations/${s.allocationId}/inspection/pre-shift`);
  await expect(
    dp.getByRole("button", { name: "Start inspection" }),
  ).toBeVisible(SLOW);
  await openChecklist(dp);
  await conn.offline(); // toggle 1: the answers are saved on the phone only
  await answerChecklist(dp);
  await expect(dp.getByTestId("progress")).toContainText("Saved on this phone");
  await conn.online(); // toggle 2: begin and the answers go
  await next(dp); // no defects: straight to the odometer photo
  await conn.offline(); // toggle 3: the photo is taken with no signal
  await takeCameraPhoto(
    dp,
    dp.getByRole("button", { name: "Take odometer photo" }),
    { acknowledge: true },
  );
  await enterReading(dp, 12345); // 5A: the driver types the reading shown in the photo (DEC-05)
  await expect(
    dp.getByTestId("odometer-step").getByTestId("photo-queued"),
  ).toBeVisible();
  await conn.online(); // toggle 4: slot -> upload -> register -> attach (aborted once) -> retried
  await next(dp);
  await dp.getByRole("button", { name: "Submit inspection" }).click();
  await conn.offline(); // toggle 5: right after Submit
  await conn.online(); // toggle 6
  await expect(dp.getByTestId("inspection-submitted")).toBeVisible(SLOW);

  // one request really failed, and was sent again with the SAME client_submission_id
  expect(aborted).toBeTruthy();
  const attempts = sent.filter((x) => x.csid === aborted);
  expect(attempts.length).toBeGreaterThanOrEqual(2);
  expect(new Set(attempts.map((a) => a.op))).toEqual(
    new Set(["attach_odometer"]),
  );
  // no client_submission_id was ever used for two different operations
  const byCsid = new Map<string, Set<string>>();
  for (const x of sent)
    if (x.csid) byCsid.set(x.csid, (byCsid.get(x.csid) ?? new Set()).add(x.op));
  for (const [csid, o] of byCsid) expect([...o], csid).toHaveLength(1);

  // no duplicate rows (through the API)
  const rows = await inspectionRows(s, "pre_shift");
  expect(rows).toHaveLength(1);
  expect(rows[0]!.status).toBe("submitted");
  const id = rows[0]!.id;
  const count = async (
    table: "inspection_responses" | "odometer_evidence" | "inspection_requests",
  ) =>
    (
      await s.sa
        .from(table)
        .select("id", { count: "exact", head: true })
        .eq("inspection_id", id)
    ).count;
  expect(await count("inspection_responses")).toBe(20);
  expect(await count("odometer_evidence")).toBe(1);
  const { data: ledger } = await s.sa
    .from("inspection_requests")
    .select("client_submission_id, function_name")
    .eq("inspection_id", id);
  expect(new Set(ledger!.map((l) => l.client_submission_id)).size).toBe(
    ledger!.length,
  );
  expect(
    ledger!.filter((l) => l.function_name === "attach_odometer"),
  ).toHaveLength(1);
  expect(ledger!.filter((l) => l.function_name === "submit")).toHaveLength(1);
  const { count: files } = await s.sa
    .from("evidence_files")
    .select("id", { count: "exact", head: true })
    .eq("uploaded_by", s.driverProfileId);
  expect(files).toBe(1);
  await ctx.close();
});

// ================================================================================================================ (c)
test("(c) conflict: cancelled while the phone is offline -> the queue stops, a different supervisor resolves, the driver removes it", async ({
  browser,
}) => {
  test.setTimeout(600_000);
  const s = await driverScenario({
    tag: "XC",
    status: "pre_inspection_pending",
  });
  const sup1 = await branchStaff(s, "xc-sup1", "supervisor");
  const sup2 = await branchStaff(s, "xc-sup2", "supervisor");
  const { ctx, page: dp, conn } = await phoneFor(browser, { weak: false });
  await driverSignIn(dp, s.emp);
  await dp.goto(`/my-allocations/${s.allocationId}/inspection/pre-shift`);
  await expect(
    dp.getByRole("button", { name: "Start inspection" }),
  ).toBeVisible(SLOW);

  // the driver is offline and starts the inspection; everything is saved on the phone
  await conn.offline();
  await openChecklist(dp);
  await expect(banner(dp)).toHaveText("Offline — saved on this phone");

  // meanwhile a supervisor cancels the allocation
  const sctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  const sp = await sctx.newPage();
  await staffSignIn(sp, sup1);
  const day = s.day;
  await sp.goto(`/shifts/allocations?branch=${s.branchId}&date=${day}`);
  const row = sp.getByTestId("allocation-row").filter({ hasText: s.fleet });
  await row.getByRole("button", { name: "Cancel", exact: true }).click();
  const dlg = sp.getByRole("dialog");
  await dlg.getByLabel(/^Reason/).fill("Vehicle needed at another site");
  await dlg.getByRole("button", { name: "Cancel allocation" }).click();
  await expect(dlg.getByText("Allocation cancelled.")).toBeVisible();
  await dlg.getByRole("button", { name: "Close" }).click();

  // the phone reconnects: the queue stops with the server's own message, everything stays on the phone
  await conn.online();
  const panel = dp.getByTestId("sync-conflict");
  await expect(panel).toBeVisible(SLOW);
  await expect(panel.getByTestId("sync-conflict-message")).toContainText(
    /cancelled/i,
  );
  await expect(banner(dp)).toHaveAttribute("data-kind", "conflict");
  expect(await inspectionRows(s, "pre_shift")).toHaveLength(0);
  await expect(panel).toContainText("Your supervisor has been told", SLOW);
  // not removable yet: only after a supervisor resolves it
  await expect(
    dp.getByRole("button", { name: /Remove from this phone/ }),
  ).toHaveCount(0);

  // it is on the supervisor's Missing / Late page, with the server's message (no driver name anywhere)
  await sp.goto(`/shifts/missing?branch=${s.branchId}`);
  const crow = sp.getByTestId("sync-conflict-row").filter({ hasText: s.fleet });
  await expect(crow).toBeVisible();
  await expect(crow.getByTestId("conflict-message")).toContainText(
    /cancelled/i,
  );
  await expect(sp.getByText(s.emp)).toHaveCount(0);
  await expect(sp.getByTestId("missing-late-badge")).toBeVisible();

  // the supervisor who cancelled is not the reporter, but the spec asks for a DIFFERENT one: sup2 resolves
  const s2ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  const s2 = await s2ctx.newPage();
  await staffSignIn(s2, sup2);
  await s2.goto(`/shifts/missing?branch=${s.branchId}`);
  const row2 = s2.getByTestId("sync-conflict-row").filter({ hasText: s.fleet });
  await row2.getByRole("button", { name: "Resolve", exact: true }).click();
  await row2
    .getByLabel(/What was decided/)
    .fill("Cancelled in error; recorded on paper.");
  await row2
    .getByRole("button", { name: "Resolve", exact: true })
    .last()
    .click();
  await expect(row2).toHaveCount(0, SLOW); // resolved: it leaves the open list
  const { data: conflicts } = await s.sa
    .from("inspection_sync_conflicts")
    .select("reported_by, resolved_by, resolution_note, refusal_message")
    .eq("allocation_id", s.allocationId);
  expect(conflicts).toHaveLength(1);
  expect(conflicts![0]!.reported_by).toBe(s.driverProfileId);
  expect(conflicts![0]!.resolved_by).toBe(sup2.id);
  expect(conflicts![0]!.resolved_by).not.toBe(conflicts![0]!.reported_by);

  // the phone notices on its next sync, and only then offers "Remove from this phone" (with what will be removed shown first)
  await dp.goto("/home");
  const remove = dp.getByRole("button", { name: /Remove from this phone/ });
  await expect(remove).toBeVisible(SLOW);
  await expect(dp.getByTestId("sync-conflict")).toContainText(
    "Your supervisor has resolved this",
  );
  await remove.click();
  await expect(dp.getByTestId("remove-confirm")).toContainText(
    "the start of the inspection",
  );
  await expect(dp.getByTestId("remove-confirm")).toContainText(
    "Nothing on the server is changed",
  );
  await dp
    .getByTestId("remove-confirm")
    .getByRole("button", { name: "Remove from this phone" })
    .click();
  await expect(dp.getByTestId("sync-conflict")).toHaveCount(0);
  await expect(banner(dp)).toHaveCount(0);
  // nothing on the server was touched by the removal
  expect(await inspectionRows(s, "pre_shift")).toHaveLength(0);
  expect(await allocationStatus(s)).toBe("cancelled");
  await ctx.close();
  await sctx.close();
  await s2ctx.close();
});

// ================================================================================================================ (d)
test("(d) detection: planned start + 31 min with no pre-shift inspection -> Missing / Late, one finding, resolved on submit", async ({
  browser,
}) => {
  test.setTimeout(480_000);
  const s = await driverScenario({
    tag: "XD",
    status: "pre_inspection_pending",
    startedMinutesAgo: 31,
  });
  const sup = await branchStaff(s, "xd-sup", "supervisor");
  const sctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  const sp = await sctx.newPage();
  await staffSignIn(sp, sup);

  // live: on the page now, with the badge, no job needed
  await sp.goto(`/shifts/missing?branch=${s.branchId}`);
  const row = sp.getByTestId("overdue-row").filter({ hasText: s.fleet });
  await expect(row).toBeVisible();
  await expect(row).toContainText("Pre-shift");
  await expect(row.getByText(/^\d+ min$/)).toBeVisible();
  await expect(sp.getByText(s.emp)).toHaveCount(0); // no driver names
  await expect(sp.getByTestId("missing-late-badge")).toBeVisible();
  await sp.goto(`/shifts/missing?branch=${s.branchId}&stage=post_shift`);
  await expect(
    sp.getByTestId("overdue-row").filter({ hasText: s.fleet }),
  ).toHaveCount(0); // the stage filter

  // the job records it ONCE, even when it runs twice
  const sa = admin();
  const runJob = async () => {
    await enqueueInspectionWatch(sa, E2E_COMPANY_ID, { force: true });
    return await runDueJobs(
      sa,
      { [INSPECTION_WATCH_JOB]: inspectionWatchHandler(sa) },
      "e2e-watch",
    );
  };
  const findings = async () =>
    (
      await s.sa
        .from("inspection_watch_findings")
        .select("id, resolved_at, resolution, inspection_stage")
        .eq("allocation_id", s.allocationId)
    ).data ?? [];
  const first = await runJob();
  expect(first.every((o) => o.ran && o.status === "succeeded")).toBe(true);
  expect(await findings()).toHaveLength(1);
  await runJob();
  const once = await findings();
  expect(once).toHaveLength(1);
  expect(once[0]).toMatchObject({
    inspection_stage: "pre_shift",
    resolved_at: null,
  });

  // the driver submits (late, never blocked): the finding resolves
  const { ctx, page: dp } = await phoneFor(browser, { weak: false });
  await driverSignIn(dp, s.emp);
  await dp.goto(`/my-allocations/${s.allocationId}/inspection/pre-shift`);
  await dp.getByRole("button", { name: "Start inspection" }).click();
  await dp
    .getByRole("button", { name: "This is the vehicle I am inspecting" })
    .click();
  await dp.getByRole("button", { name: "I have checked this list" }).click();
  await answerChecklist(dp);
  await next(dp);
  await takeCameraPhoto(
    dp,
    dp.getByRole("button", { name: "Take odometer photo" }),
    { acknowledge: true },
  );
  await enterReading(dp, 12345); // 5A: the driver types the reading shown in the photo (DEC-05)
  await next(dp);
  await dp.getByRole("button", { name: "Submit inspection" }).click();
  await expect(dp.getByTestId("inspection-submitted")).toBeVisible(SLOW);
  await expect(dp.getByTestId("late-notice")).toBeVisible();
  await runJob();
  const resolved = await findings();
  expect(resolved).toHaveLength(1);
  expect(resolved[0]!.resolved_at).not.toBeNull();
  expect(resolved[0]!.resolution).toBe("submitted_late");
  await sp.goto(`/shifts/missing?branch=${s.branchId}`);
  await expect(
    sp.getByTestId("overdue-row").filter({ hasText: s.fleet }),
  ).toHaveCount(0);
  await ctx.close();
  await sctx.close();
});

// ================================================================================================================ (e)
test("(e) sign-out with queued items warns; the same driver resumes; another driver on the phone neither sees nor sends them", async ({
  browser,
}) => {
  test.setTimeout(480_000);
  const a = await driverScenario({
    tag: "XE1",
    status: "pre_inspection_pending",
  });
  const b = await driverScenario({
    tag: "XE2",
    status: "pre_inspection_pending",
  });
  const { ctx, page: p } = await phoneFor(browser, { weak: false });
  const sent = recordSync(p);

  // driver A: the server cannot be reached for the queue's calls (everything else works), so the work stays on the phone
  await driverSignIn(p, a.emp);
  await p.route(SYNC, (route) => route.abort("failed"));
  await p.goto(`/my-allocations/${a.allocationId}/inspection/pre-shift`);
  await expect(p.getByRole("button", { name: "Start inspection" })).toBeVisible(
    SLOW,
  );
  await openChecklist(p);
  await expect(p.getByTestId("sync-banner")).toBeVisible();

  // sign out with queued items: the warning comes first
  await p.goto("/home");
  await expect(p.getByTestId("sync-banner")).toContainText(
    /saved on this phone/,
  );
  await p.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(p.getByTestId("sign-out-warning")).toContainText(
    /saved on this phone and not sent yet/,
  );
  await expect(p.getByTestId("sign-out-warning")).toContainText(
    /sent after you next sign in here/,
  );
  await p.getByRole("button", { name: "Sign out anyway" }).click();
  await expect(p).toHaveURL(/sign-in/);
  expect(await inspectionRows(a, "pre_shift")).toHaveLength(0);

  // driver B signs in on the same phone: the first driver's items are neither shown nor sent (B's own calls are allowed through)
  await p.unroute(SYNC);
  const bSignedIn = sent.length; // everything A tried before this point was aborted
  await driverSignIn(p, b.emp);
  await p.goto("/home");
  await expect(p.getByTestId("sync-last-updated")).toBeVisible(SLOW); // B's queue ran and B's snapshot arrived
  await expect(p.getByTestId("sync-banner")).toHaveCount(0);
  await expect(p.getByTestId("sync-conflict")).toHaveCount(0);
  expect(
    sent.slice(bSignedIn).filter((x) => x.profileId === a.driverProfileId),
  ).toHaveLength(0);
  const afterB = sent.length;
  expect(await inspectionRows(a, "pre_shift")).toHaveLength(0);
  expect(await inspectionRows(b, "pre_shift")).toHaveLength(0);
  await p.getByRole("button", { name: "Sign out", exact: true }).click(); // B has nothing queued: no warning
  await expect(p).toHaveURL(/sign-in/);

  // driver A signs in again on that phone: the queue resumes and sends
  await driverSignIn(p, a.emp);
  await p.goto("/home");
  await expect
    .poll(
      async () => (await inspectionRows(a, "pre_shift"))[0]?.vehicle_confirmed,
      SLOW,
    )
    .toBe(true); // begin, then the vehicle confirmation: sent in order after the sign-in
  const rows = await inspectionRows(a, "pre_shift");
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    status: "draft",
    submitted_by: a.driverProfileId,
  });
  expect(
    sent
      .slice(afterB)
      .some((x) => x.profileId === a.driverProfileId && x.op === "begin"),
  ).toBe(true);
  expect(await inspectionRows(b, "pre_shift")).toHaveLength(0);
  await ctx.close();
});
