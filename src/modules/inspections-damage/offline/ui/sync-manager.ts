"use client";
// The phone's queue manager: one per signed-in profile, shared by every driver screen (it lives as long as the page's JS does).
// It owns the runner, the connection state and the timers, and exposes a small store for React (useSyncExternalStore).
import { useEffect, useSyncExternalStore } from "react";
import { OFFLINE_CONFIG } from "../domain/config";
import { SyncRunner, type Transport } from "../domain/runner";
import { MemoryStore, type NewItem, type QueueStore } from "../domain/store";
import {
  scopeOf,
  type ItemPayload,
  type QueueItem,
  type ScopeState,
  type Snapshot,
  type Stage,
} from "../domain/types";
import { getDeviceKey } from "@/modules/evidence-storage/ui/device-key";
import { IdbStore, StorageFullError } from "./idb-store";
import { createTransport } from "./transport";

export type SyncState = {
  /** The store has been read: render forms only when true (they start from the queue's contents). */
  ready: boolean;
  /** false: this phone cannot keep work (IndexedDB unavailable). The online flow still works. */
  persistent: boolean;
  storageFull: boolean;
  online: boolean;
  items: QueueItem[];
  scopes: ScopeState[];
  snapshot: Snapshot | null;
  sendingScope: string | null;
  sentThisRun: number;
  totalThisRun: number;
  authRequired: boolean;
  allSentRecently: boolean;
  now: number;
};

const initial = (): SyncState => ({
  ready: false,
  persistent: true,
  storageFull: false,
  online: true,
  items: [],
  scopes: [],
  snapshot: null,
  sendingScope: null,
  sentThisRun: 0,
  totalThisRun: 0,
  authRequired: false,
  allSentRecently: false,
  now: 0,
});

export type EnqueueInput = {
  allocationId: string;
  stage: Stage;
  payload: ItemPayload;
  inspectionId?: string;
  blobs?: { id: string; blob: Blob }[];
};

export class SyncManager {
  private state: SyncState = initial();
  private listeners = new Set<() => void>();
  private doneListeners = new Set<(item: QueueItem) => void>();
  private store: QueueStore | null = null;
  private transport: Transport;
  private runner: SyncRunner | null = null;
  private running = false;
  private started = false;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private interval: ReturnType<typeof setInterval> | null = null;
  private lastSnapshotTry = 0;

  constructor(
    readonly profileId: string,
    opts: { store?: QueueStore; transport?: Transport } = {},
  ) {
    this.store = opts.store ?? null;
    this.transport = opts.transport ?? createTransport(profileId);
  }

  // ------------------------------------------------------------------ React store
  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };
  getState = () => this.state;
  getServerState = () => SERVER_STATE;
  private set(patch: Partial<SyncState>) {
    this.state = { ...this.state, ...patch, now: Date.now() };
    for (const l of this.listeners) l();
  }
  onItemDone(l: (item: QueueItem) => void) {
    this.doneListeners.add(l);
    return () => {
      this.doneListeners.delete(l);
    };
  }

  // ------------------------------------------------------------------ lifecycle
  async start() {
    if (this.started || typeof window === "undefined") return;
    this.started = true;
    let persistent = true;
    if (!this.store) {
      try {
        this.store = await IdbStore.open();
      } catch {
        this.store = new MemoryStore();
        persistent = false;
      }
    }
    this.runner = new SyncRunner(this.profileId, {
      store: this.store,
      transport: this.transport,
      now: () => Date.now(),
      deviceKey: () => getDeviceKey().catch(() => null),
      onChange: () => void this.reload(),
      onItemDone: (i) => {
        for (const l of this.doneListeners) l(i);
      },
    });
    this.set({ persistent, online: navigator.onLine });
    window.addEventListener("online", this.onOnline);
    window.addEventListener("offline", this.onOffline);
    document.addEventListener("visibilitychange", this.onVisible);
    this.interval = setInterval(() => this.tick(), 15_000);
    const snap = await this.store.getSnapshot(this.profileId);
    this.set({ snapshot: snap ?? null });
    await this.reload();
    this.set({ ready: true });
    this.kick();
    void this.refreshSnapshot();
  }

  stop() {
    if (typeof window === "undefined") return;
    this.runner?.stop();
    window.removeEventListener("online", this.onOnline);
    window.removeEventListener("offline", this.onOffline);
    document.removeEventListener("visibilitychange", this.onVisible);
    if (this.interval) clearInterval(this.interval);
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    this.started = false;
  }

  private onOnline = () => {
    this.set({ online: true });
    this.kick();
    void this.refreshSnapshot();
  };
  private onOffline = () => this.set({ online: false });
  private onVisible = () => {
    if (document.visibilityState === "visible") this.tick();
  };
  private tick() {
    this.set({ online: navigator.onLine });
    this.kick();
    if (
      Date.now() - this.lastSnapshotTry >
      OFFLINE_CONFIG.snapshotRefreshMinutes * 60_000
    )
      void this.refreshSnapshot();
  }

  async reload() {
    if (!this.store) return;
    const [items, scopes] = await Promise.all([
      this.store.list(this.profileId),
      this.store.scopes(this.profileId),
    ]);
    this.set({
      items,
      scopes,
      sendingScope: this.runner?.sendingScope ?? null,
      sentThisRun: this.running
        ? Math.max(0, this.state.totalThisRun - items.length)
        : 0,
    });
  }

  // ------------------------------------------------------------------ writing
  /** Every inspection write goes through here, online or offline: ONE path. Returns once the item is safely stored on the phone. */
  async enqueue(input: EnqueueInput): Promise<QueueItem> {
    if (!this.store) throw new Error("The phone's storage is not ready yet.");
    const scope = scopeOf(input.allocationId, input.stage);
    // A save that has never been attempted and is not being sent can take the newer answers (same id: nothing was sent yet).
    if (input.payload.kind === "save" && !this.running) {
      const mine = this.state.items.filter((i) => i.scope === scope);
      const last = mine[mine.length - 1];
      if (last && last.kind === "save" && last.attempts === 0) {
        const updated = { ...last, payload: input.payload };
        await this.store.update(updated);
        await this.reload();
        this.kick();
        return updated;
      }
    }
    const item: NewItem = {
      id: crypto.randomUUID(),
      profileId: this.profileId,
      scope,
      allocationId: input.allocationId,
      stage: input.stage,
      kind: input.payload.kind,
      csid: crypto.randomUUID(),
      inspectionId: input.inspectionId,
      payload: input.payload,
      deviceTime: new Date().toISOString(),
      createdAt: Date.now(),
      capturedOffline: !navigator.onLine,
      attempts: 0,
      nextAttemptAt: 0,
    };
    let stored: QueueItem;
    try {
      stored = await this.store.add(item, input.blobs);
    } catch (e) {
      if (e instanceof StorageFullError) this.set({ storageFull: true });
      throw e;
    }
    if (this.state.storageFull) this.set({ storageFull: false });
    if (this.running) this.set({ totalThisRun: this.state.totalThisRun + 1 });
    await this.reload();
    this.kick();
    return stored;
  }

  /** "Remove from this phone": only after a supervisor resolved the conflict. Nothing on the server is touched. */
  async removeScope(scope: string) {
    if (!this.store) return;
    const state = this.state.scopes.find((s) => s.scope === scope);
    if (state?.status !== "resolved") return;
    const ids = this.state.items
      .filter((i) => i.scope === scope)
      .map((i) => i.id);
    await this.store.remove(this.profileId, ids);
    await this.store.deleteScope(this.profileId, scope);
    await this.store.clearRef(this.profileId, scope);
    await this.reload();
  }

  // ------------------------------------------------------------------ sending
  kick() {
    if (!this.runner || !this.store || this.running) return;
    if (!navigator.onLine) return;
    void this.run();
  }

  private async run() {
    if (!this.runner || this.running) return;
    this.running = true;
    this.set({ totalThisRun: this.state.items.length, sentThisRun: 0 });
    let sent = 0;
    let auth = false;
    try {
      const r = await this.runner.drain();
      sent = r.sent;
      auth = r.auth;
    } catch {
      /* the runner already keeps what it could not send */
    } finally {
      this.running = false;
    }
    await this.reload();
    this.set({ authRequired: auth, sendingScope: null });
    if (sent > 0 && this.state.items.length === 0) {
      this.set({ allSentRecently: true });
      this.timers.push(
        setTimeout(() => this.set({ allSentRecently: false }), 5_000),
      );
      void this.refreshSnapshot();
    }
    const wake = await this.runner.wakeAt();
    if (wake !== null && !auth) {
      this.timers.push(
        setTimeout(() => this.kick(), Math.max(500, wake - Date.now())),
      );
    }
  }

  // ------------------------------------------------------------------ snapshot
  async refreshSnapshot(): Promise<boolean> {
    if (!this.store || !navigator.onLine) return false;
    this.lastSnapshotTry = Date.now();
    const o = await this.transport.call("snapshot", {});
    if (o.kind !== "ok") return false;
    const snap = o.data.snapshot as Snapshot | undefined;
    if (!snap || snap.profileId !== this.profileId) return false;
    await this.store.putSnapshot(snap);
    this.set({ snapshot: snap });
    return true;
  }
}

const SERVER_STATE = initial();
let current: SyncManager | null = null;

/** The one manager for this profile. A different profile (another driver signed in on this phone) stops the previous manager. */
export function getSyncManager(profileId: string): SyncManager {
  // on the server (SSR) nothing is shared between requests: a throwaway, never started manager
  if (typeof window === "undefined") return new SyncManager(profileId);
  if (current && current.profileId === profileId) return current;
  current?.stop();
  current = new SyncManager(profileId);
  return current;
}

export function useSync(profileId: string) {
  const manager = getSyncManager(profileId);
  const state = useSyncExternalStore(
    manager.subscribe,
    manager.getState,
    manager.getServerState,
  );
  useEffect(() => {
    void manager.start();
  }, [manager]);
  return { state, manager };
}
