import { describe, expect, it } from "vitest";
import { OFFLINE_CONFIG } from "./config";
import { blockedScopes, nextWakeAt, pickNext } from "./order";
import {
  bannerFor,
  BANNER_TEXT,
  describeItems,
  scopeStatus,
  stuckItems,
} from "./status";
import type { QueueItem, ScopeState } from "./types";

const item = (
  seq: number,
  scope: string,
  over: Partial<QueueItem> = {},
): QueueItem => ({
  id: `i${seq}`,
  profileId: "p1",
  seq,
  scope,
  allocationId: scope.split(":")[0]!,
  stage: "pre_shift",
  kind: "save",
  csid: `c${seq}`,
  payload: { kind: "save", responses: [], vehicleConfirmed: false },
  deviceTime: "2026-11-25T08:00:00.000Z",
  createdAt: 1_000_000,
  capturedOffline: true,
  attempts: 0,
  nextAttemptAt: 0,
  ...over,
});
const conflict = (
  scope: string,
  status: ScopeState["status"] = "conflict",
): ScopeState => ({
  profileId: "p1",
  scope,
  allocationId: scope.split(":")[0]!,
  stage: "pre_shift",
  status,
  itemId: "i1",
  itemKind: "save",
  conflictCsid: "c1",
  code: "55000",
  message: "cancelled",
  deviceTime: "x",
  detectedAt: 0,
  reported: true,
});

describe("queue ordering", () => {
  it("only the first item of a scope can be sent: a later item waits for the earlier one", () => {
    const items = [
      item(2, "a:pre_shift"),
      item(1, "a:pre_shift", { nextAttemptAt: 500 }),
    ];
    expect(pickNext(items, [], 100)).toBeNull(); // item 1 is waiting for its backoff; item 2 must not jump ahead
    expect(pickNext(items, [], 500)!.id).toBe("i1");
  });
  it("picks the lowest sequence across scopes, and a waiting scope never blocks another", () => {
    const items = [
      item(1, "a:pre_shift", { nextAttemptAt: 900 }),
      item(2, "b:pre_shift"),
      item(3, "a:pre_shift"),
    ];
    expect(pickNext(items, [], 100)!.id).toBe("i2");
  });
  it("a scope with a conflict (or a resolved conflict) is never sent; other scopes still are", () => {
    const items = [item(1, "a:pre_shift"), item(2, "b:pre_shift")];
    expect(pickNext(items, [conflict("a:pre_shift")], 0)!.id).toBe("i2");
    expect(pickNext(items, [conflict("a:pre_shift", "resolved")], 0)!.id).toBe(
      "i2",
    );
    expect(blockedScopes([conflict("a:pre_shift")]).has("a:pre_shift")).toBe(
      true,
    );
  });
  it("wake-up time is the earliest backoff of a sendable scope", () => {
    const items = [
      item(1, "a:pre_shift", { nextAttemptAt: 900 }),
      item(2, "b:pre_shift", { nextAttemptAt: 700 }),
      item(3, "c:pre_shift", { nextAttemptAt: 100 }),
    ];
    expect(nextWakeAt(items, [conflict("b:pre_shift")], 200)).toBe(900);
    expect(nextWakeAt([], [], 0)).toBeNull();
  });
});

describe("the 30-minute warning (DEC-43)", () => {
  const T = OFFLINE_CONFIG.stuckAfterMinutes * 60_000;
  it("the value lives in the client config", () => {
    expect(OFFLINE_CONFIG.stuckAfterMinutes).toBe(30);
  });
  it("an item is stuck once it has waited 30 minutes, not before", () => {
    const items = [item(1, "a:pre_shift")];
    expect(stuckItems(items, 1_000_000 + T - 1)).toHaveLength(0);
    expect(stuckItems(items, 1_000_000 + T)).toHaveLength(1);
  });
  const base = {
    online: true,
    scopes: [],
    sending: false,
    sentThisRun: 0,
    totalThisRun: 0,
    allSentRecently: false,
  };
  it("banner wording", () => {
    const items = [item(1, "a:pre_shift"), item(2, "a:pre_shift")];
    expect(bannerFor({ ...base, items: [], now: 0 }).kind).toBe("none");
    expect(
      bannerFor({ ...base, items: [], allSentRecently: true, now: 0 }).text,
    ).toBe("All sent");
    expect(
      bannerFor({ ...base, online: false, items, now: 1_000_000 }).text,
    ).toBe("Offline — saved on this phone");
    expect(
      bannerFor({
        ...base,
        items,
        now: 1_000_000,
        sending: true,
        sentThisRun: 2,
        totalThisRun: 7,
      }).text,
    ).toBe("Sending 3 of 7…");
    expect(bannerFor({ ...base, items, now: 1_000_000 }).kind).toBe("waiting");
    expect(bannerFor({ ...base, items, now: 1_000_000 + T }).text).toBe(
      "Still not sent after 30 min — keep the app open when you have signal",
    );
    expect(
      bannerFor({ ...base, online: false, items, now: 1_000_000 + T }).kind,
    ).toBe("stuck");
    expect(BANNER_TEXT.stuck(30)).toContain("30 min");
  });
  it("a conflict is reported on the banner", () => {
    expect(
      bannerFor({
        ...base,
        items: [],
        scopes: [conflict("a:pre_shift")],
        now: 0,
      }).kind,
    ).toBe("conflict");
  });
});

describe("per-inspection status and the removal summary", () => {
  it("synced / saved on this phone / sending / conflict / resolved", () => {
    const items = [item(1, "a:pre_shift")];
    expect(scopeStatus("b:pre_shift", items, [], null)).toBe("synced");
    expect(scopeStatus("a:pre_shift", items, [], null)).toBe("saved_on_phone");
    expect(scopeStatus("a:pre_shift", items, [], "a:pre_shift")).toBe(
      "sending",
    );
    expect(
      scopeStatus("a:pre_shift", items, [conflict("a:pre_shift")], null),
    ).toBe("conflict");
    expect(
      scopeStatus(
        "a:pre_shift",
        items,
        [conflict("a:pre_shift", "resolved")],
        null,
      ),
    ).toBe("resolved");
  });
  it("describes what will be removed", () => {
    const photo = {
      blobId: "b",
      size: 1,
      width: 1,
      height: 1,
      capturedAt: "x",
      location: null,
      capturedOffline: true,
    };
    const items = [
      item(1, "a:pre_shift", { kind: "begin", payload: { kind: "begin" } }),
      item(2, "a:pre_shift"),
      item(3, "a:pre_shift", {
        kind: "photo",
        payload: {
          kind: "photo",
          target: { kind: "odometer" },
          photo,
          attachCsid: "x",
        },
      }),
      item(4, "a:pre_shift", { kind: "submit", payload: { kind: "submit" } }),
    ];
    expect(describeItems(items)).toEqual([
      "the start of the inspection",
      "your saved answers",
      "1 photo",
      "the submit",
    ]);
  });
});
