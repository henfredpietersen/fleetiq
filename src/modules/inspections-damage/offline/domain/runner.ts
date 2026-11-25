// The send loop (ARCH §6.9). Pure of browser APIs: storage, transport and clock are injected, so ordering, backoff, replay,
// conflict handling and slot re-issue are unit-tested without a phone.
//
// Rules (DEC-06, DEC-43):
//  * items of one scope go strictly in order; the first item of a scope is the only one sent;
//  * a retry carries the SAME client_submission_id; a replay answer counts as success;
//  * retry = wait (exponential backoff); refused = CONFLICT: the scope stops, everything stays on the phone, the server's message is
//    kept as is and reported; auth = pause until the next sign-in (never send under another user's session);
//  * an item (and a photo blob) is removed only after the server confirmed it: attach / report_damage / the write itself.
import { backoffMs, type Outcome, type PutOutcome } from "./classify";
import { OFFLINE_CONFIG } from "./config";
import { pickNext, nextWakeAt } from "./order";
import type { QueueStore } from "./store";
import type {
  ItemKind,
  PhotoMeta,
  QueueItem,
  ScopeState,
  Stage,
} from "./types";

export type SyncOp =
  | "begin"
  | "save"
  | "confirm_known"
  | "slot"
  | "register"
  | "attach_odometer"
  | "attach_defect"
  | "report_damage"
  | "submit"
  | "report_conflict"
  | "conflict_status"
  | "snapshot";

export interface Transport {
  call(op: SyncOp, body: Record<string, unknown>): Promise<Outcome>;
  put(url: string, blob: Blob): Promise<PutOutcome>;
}

export type RunnerDeps = {
  store: QueueStore;
  transport: Transport;
  now: () => number;
  deviceKey: () => Promise<string | null>;
  /** Called after every state change (the UI re-reads the store). */
  onChange?: () => void;
  /** Called when the server confirmed an item and it was cleared from the phone (a photo is now "Attached"). */
  onItemDone?: (item: QueueItem) => void;
  config?: Pick<typeof OFFLINE_CONFIG, "slotReissueAttempts" | "backoff">;
};

type Step =
  | { r: "done" }
  | { r: "retry"; message: string }
  | { r: "refused"; code: string; message: string }
  | { r: "auth"; message: string };

type Fail = Exclude<Step, { r: "done" }>;
const failOf = (o: Exclude<Outcome, { kind: "ok" }>): Fail =>
  o.kind === "retry"
    ? { r: "retry", message: o.message }
    : o.kind === "auth"
      ? { r: "auth", message: o.message }
      : { r: "refused", code: o.code, message: o.message };
const fromOutcome = (o: Outcome): Step =>
  o.kind === "ok" ? { r: "done" } : failOf(o);

/** The database function each queued kind ends in: what a supervisor reads on the Missing / Late page. */
export function functionNameOf(item: QueueItem): string {
  const p = item.payload;
  switch (p.kind) {
    case "begin":
      return "begin_inspection";
    case "save":
      return "save_inspection_responses";
    case "confirm_known":
      return "confirm_known_damage_reviewed";
    case "photo":
      return p.target.kind === "odometer"
        ? "attach_odometer_photo"
        : "attach_inspection_photo";
    case "report_damage":
      return "report_damage";
    case "submit":
      return "submit_inspection";
  }
}

export type DrainResult = { sent: number; auth: boolean };

export class SyncRunner {
  private stopped = false;
  private inFlight: { itemId: string; scope: string } | null = null;
  constructor(
    readonly profileId: string,
    private deps: RunnerDeps,
  ) {}

  get sendingScope(): string | null {
    return this.inFlight?.scope ?? null;
  }
  get sendingItemId(): string | null {
    return this.inFlight?.itemId ?? null;
  }
  stop() {
    this.stopped = true;
  }
  private changed() {
    this.deps.onChange?.();
  }

  /** Sends everything that is due. Returns when nothing more can be sent now. */
  async drain(): Promise<DrainResult> {
    const { store, now } = this.deps;
    let sent = 0;
    while (!this.stopped) {
      const [items, scopes] = await Promise.all([
        store.list(this.profileId),
        store.scopes(this.profileId),
      ]);
      const next = pickNext(items, scopes, now());
      if (!next) break;
      this.inFlight = { itemId: next.id, scope: next.scope };
      this.changed();
      let step: Step;
      try {
        step = await this.send(next);
      } catch (e) {
        step = {
          r: "retry",
          message: e instanceof Error ? e.message : "Could not send.",
        };
      }
      this.inFlight = null;
      if (step.r === "done") {
        sent++;
        this.deps.onItemDone?.(next);
        this.changed();
        continue;
      }
      if (step.r === "auth") {
        this.changed();
        return { sent, auth: true };
      }
      // the item as it is now: a photo may have saved its upload progress (evidenceFileId) during this send
      const cur =
        (await store.list(this.profileId)).find((i) => i.id === next.id) ??
        next;
      if (step.r === "retry") {
        const attempts = cur.attempts + 1;
        await store.update({
          ...cur,
          attempts,
          lastError: step.message,
          nextAttemptAt: now() + backoffMs(attempts, this.deps.config?.backoff),
        });
      } else {
        await this.conflict(cur, step.code, step.message);
      }
      this.changed();
    }
    const auth = await this.housekeeping();
    return { sent, auth };
  }

  /** When the loop should run again by itself (a waiting item's backoff), or null. */
  async wakeAt(): Promise<number | null> {
    const [items, scopes] = await Promise.all([
      this.deps.store.list(this.profileId),
      this.deps.store.scopes(this.profileId),
    ]);
    return nextWakeAt(items, scopes, this.deps.now());
  }

  private async conflict(item: QueueItem, code: string, message: string) {
    const { store, now } = this.deps;
    const inspectionId =
      item.inspectionId ?? (await store.getRef(this.profileId, item.scope));
    await store.update({
      ...item,
      attempts: item.attempts + 1,
      lastError: message,
    });
    await store.putScope({
      profileId: this.profileId,
      scope: item.scope,
      allocationId: item.allocationId,
      stage: item.stage,
      status: "conflict",
      itemId: item.id,
      itemKind: item.kind,
      conflictCsid: item.csid,
      inspectionId,
      code,
      message,
      deviceTime: item.deviceTime,
      detectedAt: now(),
      reported: false,
    });
  }

  /** Report new conflicts to the server and ask whether a supervisor has resolved the reported ones. */
  private async housekeeping(): Promise<boolean> {
    const { store, transport } = this.deps;
    const scopes = await store.scopes(this.profileId);
    if (scopes.length === 0) return false;
    const items = await store.list(this.profileId);
    for (const s of scopes) {
      if (s.reported) continue;
      const item = items.find((i) => i.id === s.itemId);
      const o = await transport.call("report_conflict", {
        allocationId: s.allocationId,
        inspectionId: s.inspectionId ?? null,
        functionName: item ? functionNameOf(item) : s.itemKind,
        refusalCode: s.code,
        refusalMessage: s.message,
        deviceTime: s.deviceTime,
        clientSubmissionId: s.conflictCsid,
      });
      if (o.kind === "auth") return true;
      if (o.kind === "ok") {
        await store.putScope({
          ...s,
          reported: true,
          conflictId:
            typeof o.data.conflictId === "string"
              ? o.data.conflictId
              : undefined,
        });
        this.changed();
      }
    }
    const open = (await store.scopes(this.profileId)).filter(
      (s) => s.reported && s.status === "conflict",
    );
    if (open.length > 0) {
      const o = await transport.call("conflict_status", {
        clientSubmissionIds: open.map((s) => s.conflictCsid),
      });
      if (o.kind === "auth") return true;
      if (o.kind === "ok" && Array.isArray(o.data.conflicts)) {
        for (const c of o.data.conflicts as {
          clientSubmissionId: string;
          resolved: boolean;
          note?: string | null;
          resolvedAt?: string | null;
        }[]) {
          const s = open.find((x) => x.conflictCsid === c.clientSubmissionId);
          if (s && c.resolved) {
            await store.putScope({
              ...s,
              status: "resolved",
              resolutionNote: c.note ?? undefined,
              resolvedAt: c.resolvedAt ?? undefined,
            });
            this.changed();
          }
        }
      }
    }
    return false;
  }

  // ------------------------------------------------------------------ one item
  private call(op: SyncOp, body: Record<string, unknown>) {
    return this.deps.transport.call(op, body);
  }

  private async send(item: QueueItem): Promise<Step> {
    const { store } = this.deps;
    const p = item.payload;
    if (p.kind === "begin") {
      const o = await this.call("begin", {
        allocationId: item.allocationId,
        stage: item.stage,
        deviceStartedAt: item.deviceTime,
        capturedOffline: item.capturedOffline,
        clientSubmissionId: item.csid,
      });
      if (o.kind !== "ok") return fromOutcome(o);
      const id = o.data.inspectionId;
      if (typeof id !== "string")
        return {
          r: "retry",
          message: "The server's answer was not understood.",
        };
      await store.setRef(this.profileId, item.scope, id);
      await store.remove(this.profileId, [item.id]);
      return { r: "done" };
    }

    const inspectionId =
      item.inspectionId ?? (await store.getRef(this.profileId, item.scope));
    if (!inspectionId)
      return {
        r: "retry",
        message: "Waiting for the inspection to be started on the server.",
      };

    if (p.kind === "save") {
      return this.finish(
        item,
        await this.call("save", {
          inspectionId,
          responses: p.responses,
          vehicleConfirmed: p.vehicleConfirmed,
          clientSubmissionId: item.csid,
        }),
      );
    }
    if (p.kind === "confirm_known") {
      return this.finish(
        item,
        await this.call("confirm_known", {
          inspectionId,
          clientSubmissionId: item.csid,
        }),
      );
    }
    if (p.kind === "submit") {
      const r = this.finish(
        item,
        await this.call("submit", {
          inspectionId,
          deviceSubmittedAt: item.deviceTime,
          capturedOffline: item.capturedOffline,
          clientSubmissionId: item.csid,
        }),
      );
      return r;
    }
    if (p.kind === "photo") {
      let fileId = p.evidenceFileId;
      if (!fileId) {
        const up = await this.uploadAndRegister(
          item,
          inspectionId,
          item.csid,
          p.photo,
          p.target.kind === "odometer" ? "odometer" : "defect",
        );
        if (up.r !== "uploaded") return up;
        fileId = up.evidenceFileId;
        await store.update({
          ...item,
          payload: { ...p, evidenceFileId: fileId },
        });
      }
      return this.finish(
        item,
        p.target.kind === "odometer"
          ? await this.call("attach_odometer", {
              inspectionId,
              evidenceFileId: fileId,
              clientSubmissionId: p.attachCsid,
            })
          : await this.call("attach_defect", {
              inspectionId,
              evidenceFileId: fileId,
              templateItemId: p.target.templateItemId,
              clientSubmissionId: p.attachCsid,
            }),
      );
    }
    // report_damage: every photo is registered first (each with its own slot csid), then the report names them
    const photos = [...p.photos];
    for (let n = 0; n < photos.length; n++) {
      const ph = photos[n]!;
      if (ph.evidenceFileId) continue;
      const up = await this.uploadAndRegister(
        item,
        inspectionId,
        ph.slotCsid,
        ph.photo,
        "damage",
      );
      if (up.r !== "uploaded") return up;
      photos[n] = { ...ph, evidenceFileId: up.evidenceFileId };
      await store.update({ ...item, payload: { ...p, photos: [...photos] } });
    }
    return this.finish(
      item,
      await this.call("report_damage", {
        inspectionId,
        zone: p.zone,
        severity: p.severity,
        description: p.description,
        evidenceFileIds: photos.map((x) => x.evidenceFileId),
        deviceReportedAt: item.deviceTime,
        capturedOffline: item.capturedOffline,
        clientSubmissionId: item.csid,
      }),
    );
  }

  /** Removes the item (and its blobs) only on a confirmed answer; otherwise reports how it went. */
  private async finish(item: QueueItem, o: Outcome): Promise<Step> {
    if (o.kind === "ok") {
      await this.deps.store.remove(this.profileId, [item.id]);
      return { r: "done" };
    }
    return fromOutcome(o);
  }

  /** slot -> upload -> register. The slot is requested immediately before the upload; an expired slot is requested again with the SAME csid. */
  private async uploadAndRegister(
    item: QueueItem,
    inspectionId: string,
    slotCsid: string,
    photo: PhotoMeta,
    kind: "odometer" | "defect" | "damage",
  ): Promise<
    Exclude<Step, { r: "done" }> | { r: "uploaded"; evidenceFileId: string }
  > {
    const { store, transport } = this.deps;
    const blob = await store.getBlob(this.profileId, photo.blobId);
    if (!blob)
      return {
        r: "refused",
        code: "LOCAL",
        message: "The photo is no longer stored on this phone.",
      };
    const attempts =
      this.deps.config?.slotReissueAttempts ??
      OFFLINE_CONFIG.slotReissueAttempts;
    for (let n = 0; n < attempts; n++) {
      const s = await this.call("slot", {
        inspectionId,
        kind,
        sizeBytes: blob.size,
        deviceCaptureAt: photo.capturedAt,
        location: photo.location,
        capturedOffline: photo.capturedOffline,
        deviceKey: await this.deps.deviceKey(),
        clientSubmissionId: slotCsid,
      });
      if (s.kind !== "ok") return failOf(s);
      const slot = s.data.slot as {
        slotId: string;
        uploadUrl: string | null;
        alreadyUploaded: boolean;
        alreadyRegistered: boolean;
        evidenceFileId: string | null;
      };
      if (slot.alreadyRegistered && slot.evidenceFileId)
        return { r: "uploaded", evidenceFileId: slot.evidenceFileId };
      if (!slot.alreadyUploaded) {
        if (!slot.uploadUrl)
          return { r: "retry", message: "Could not prepare the upload." };
        const put = await transport.put(slot.uploadUrl, blob);
        if (put === "retry")
          return {
            r: "retry",
            message: "The photo could not be uploaded. It will be tried again.",
          };
        if (put === "expired") continue;
      }
      const reg = await this.call("register", { slotId: slot.slotId });
      if (reg.kind === "refused" && reg.code === "SLOT_EXPIRED") continue;
      if (reg.kind !== "ok") return failOf(reg);
      const ev = reg.data.evidence as { evidenceFileId: string } | undefined;
      if (!ev?.evidenceFileId)
        return {
          r: "retry",
          message: "The server's answer was not understood.",
        };
      return { r: "uploaded", evidenceFileId: ev.evidenceFileId };
    }
    return {
      r: "retry",
      message: "The upload window expired; it will be tried again.",
    };
  }
}

export type { ItemKind, ScopeState, Stage };
