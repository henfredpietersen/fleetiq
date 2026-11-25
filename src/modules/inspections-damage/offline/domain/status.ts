// What the driver sees about the queue: the connection banner, the "still not sent" warning, per-inspection status.
import { OFFLINE_CONFIG } from "./config";
import { groupByScope } from "./order";
import type { QueueItem, ScopeState } from "./types";

export const BANNER_TEXT = {
  offline: "Offline — saved on this phone",
  allSent: "All sent",
  waiting: (n: number) =>
    `${n} ${n === 1 ? "item" : "items"} saved on this phone — will be sent shortly`,
  sending: (done: number, total: number) => `Sending ${done} of ${total}…`,
  stuck: (minutes: number) =>
    `Still not sent after ${minutes} min — keep the app open when you have signal`,
  conflict:
    "The server could not accept some of your work. It is kept on this phone and your supervisor has been told.",
} as const;

/** DEC-43: an item that has waited at least `minutes` is "stuck". Phone clock (only used for this warning). */
export function stuckItems(
  items: QueueItem[],
  now: number,
  minutes: number = OFFLINE_CONFIG.stuckAfterMinutes,
): QueueItem[] {
  return items.filter((i) => now - i.createdAt >= minutes * 60_000);
}

export type BannerKind =
  | "none"
  | "offline"
  | "sending"
  | "waiting"
  | "stuck"
  | "conflict"
  | "all_sent";

export type Banner = { kind: BannerKind; text: string };

/**
 * `sentThisRun`/`totalThisRun`: "Sending 3 of 7" counts the items that were queued when the current run began.
 * `allSentRecently`: shown for a few seconds after the queue empties.
 */
export function bannerFor(i: {
  online: boolean;
  items: QueueItem[];
  scopes: ScopeState[];
  now: number;
  sending: boolean;
  sentThisRun: number;
  totalThisRun: number;
  allSentRecently: boolean;
  stuckMinutes?: number;
}): Banner {
  const minutes = i.stuckMinutes ?? OFFLINE_CONFIG.stuckAfterMinutes;
  const hasConflict = i.scopes.some((s) => s.status === "conflict");
  if (i.items.length === 0) {
    if (hasConflict) return { kind: "conflict", text: BANNER_TEXT.conflict };
    return i.allSentRecently
      ? { kind: "all_sent", text: BANNER_TEXT.allSent }
      : { kind: "none", text: "" };
  }
  if (stuckItems(i.items, i.now, minutes).length > 0)
    return { kind: "stuck", text: BANNER_TEXT.stuck(minutes) };
  if (hasConflict) return { kind: "conflict", text: BANNER_TEXT.conflict };
  if (!i.online) return { kind: "offline", text: BANNER_TEXT.offline };
  if (i.sending)
    return {
      kind: "sending",
      text: BANNER_TEXT.sending(
        Math.min(i.sentThisRun + 1, Math.max(i.totalThisRun, 1)),
        Math.max(i.totalThisRun, i.items.length),
      ),
    };
  return { kind: "waiting", text: BANNER_TEXT.waiting(i.items.length) };
}

export type ScopeStatus =
  "synced" | "saved_on_phone" | "sending" | "conflict" | "resolved";

/** Per-inspection status for one scope. */
export function scopeStatus(
  scope: string,
  items: QueueItem[],
  scopes: ScopeState[],
  sendingScope: string | null,
): ScopeStatus {
  const s = scopes.find((x) => x.scope === scope);
  if (s?.status === "conflict") return "conflict";
  if (s?.status === "resolved") return "resolved";
  const mine = groupByScope(items).get(scope);
  if (!mine || mine.length === 0) return "synced";
  return sendingScope === scope ? "sending" : "saved_on_phone";
}

export const SCOPE_STATUS_TEXT: Record<ScopeStatus, string> = {
  synced: "",
  saved_on_phone: "Saved on this phone — not sent yet",
  sending: "Sending…",
  conflict: "Not accepted by the server — kept on this phone",
  resolved: "Your supervisor has resolved this",
};

/** Plain words for what "Remove from this phone" will remove, shown BEFORE the driver confirms. */
export function describeItems(items: QueueItem[]): string[] {
  const n = (k: QueueItem["kind"]) => items.filter((i) => i.kind === k).length;
  const out: string[] = [];
  if (n("begin")) out.push("the start of the inspection");
  if (n("save")) out.push("your saved answers");
  if (n("confirm_known")) out.push("the known-damage check");
  const photos = items.filter((i) => i.kind === "photo").length;
  const dmgPhotos = items.reduce(
    (t, i) =>
      t + (i.payload.kind === "report_damage" ? i.payload.photos.length : 0),
    0,
  );
  if (photos + dmgPhotos)
    out.push(
      `${photos + dmgPhotos} ${photos + dmgPhotos === 1 ? "photo" : "photos"}`,
    );
  if (n("report_damage"))
    out.push(
      `${n("report_damage")} damage ${n("report_damage") === 1 ? "report" : "reports"}`,
    );
  if (n("submit")) out.push("the submit");
  return out;
}
