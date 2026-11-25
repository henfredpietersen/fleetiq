"use client";
// The phone's storage in IndexedDB (ARCH §6.9). One database, five stores; EVERY record carries the profile id and every read is
// filtered by it, so one driver's queue is never shown to or sent for another (DEC-43).
//   items      the ordered queue of writes (keyPath id; index profile)
//   blobs      the ~1600 px JPEGs from the in-app camera, until the server has attached them (key profile|blobId)
//   scopes     per-inspection conflict state (key profile|scope; index profile)
//   refs       scope -> the server's inspection id once `begin` has been confirmed (key profile|scope)
//   snapshots  the 24-hour snapshot per profile, with "last updated"
//   meta       the sequence counter
import { blobIdsOf, type NewItem, type QueueStore } from "../domain/store";
import type { QueueItem, ScopeState, Snapshot } from "../domain/types";

const DB_NAME = "fleetiq-offline";
const DB_VERSION = 1;

export class StoreUnavailableError extends Error {}
export class StorageFullError extends Error {}

const req = <T>(r: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
const done = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
const isQuota = (e: unknown) =>
  e instanceof DOMException &&
  (e.name === "QuotaExceededError" || e.code === 22);

export function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new StoreUnavailableError("IndexedDB is not available"));
      return;
    }
    let open: IDBOpenDBRequest;
    try {
      open = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (e) {
      reject(new StoreUnavailableError(String(e)));
      return;
    }
    open.onupgradeneeded = () => {
      const db = open.result;
      const items = db.createObjectStore("items", { keyPath: "id" });
      items.createIndex("profile", "profileId");
      db.createObjectStore("blobs", { keyPath: "key" });
      const scopes = db.createObjectStore("scopes", { keyPath: "key" });
      scopes.createIndex("profile", "profileId");
      db.createObjectStore("refs", { keyPath: "key" });
      db.createObjectStore("snapshots", { keyPath: "profileId" });
      db.createObjectStore("meta", { keyPath: "key" });
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () =>
      reject(new StoreUnavailableError(String(open.error ?? "open failed")));
    open.onblocked = () =>
      reject(new StoreUnavailableError("IndexedDB is blocked"));
  });
}

export class IdbStore implements QueueStore {
  private constructor(private db: IDBDatabase) {}
  static async open(): Promise<IdbStore> {
    return new IdbStore(await openDb());
  }

  async list(profileId: string): Promise<QueueItem[]> {
    const tx = this.db.transaction("items");
    const all = await req(
      tx.objectStore("items").index("profile").getAll(profileId),
    );
    return (all as QueueItem[]).sort((a, b) => a.seq - b.seq);
  }

  async add(
    item: NewItem,
    blobs: { id: string; blob: Blob }[] = [],
  ): Promise<QueueItem> {
    const tx = this.db.transaction(["items", "blobs", "meta"], "readwrite");
    try {
      const meta = tx.objectStore("meta");
      const cur = (await req(meta.get("seq"))) as
        { key: string; value: number } | undefined;
      const seq = (cur?.value ?? 0) + 1;
      meta.put({ key: "seq", value: seq });
      const stored = { ...item, seq } as QueueItem;
      tx.objectStore("items").put(stored);
      for (const b of blobs)
        tx.objectStore("blobs").put({
          key: `${item.profileId}|${b.id}`,
          profileId: item.profileId,
          blob: b.blob,
        });
      await done(tx);
      return stored;
    } catch (e) {
      try {
        tx.abort();
      } catch {
        /* already finished */
      }
      if (isQuota(e) || isQuota(tx.error))
        throw new StorageFullError("This phone's storage is full.");
      throw e;
    }
  }

  async update(item: QueueItem): Promise<void> {
    const tx = this.db.transaction("items", "readwrite");
    const existing = await req(tx.objectStore("items").get(item.id));
    if (existing && (existing as QueueItem).profileId === item.profileId)
      tx.objectStore("items").put(item);
    await done(tx);
  }

  async remove(profileId: string, itemIds: string[]): Promise<void> {
    const tx = this.db.transaction(["items", "blobs"], "readwrite");
    for (const id of itemIds) {
      const it = (await req(tx.objectStore("items").get(id))) as
        QueueItem | undefined;
      if (!it || it.profileId !== profileId) continue;
      for (const b of blobIdsOf(it))
        tx.objectStore("blobs").delete(`${profileId}|${b}`);
      tx.objectStore("items").delete(id);
    }
    await done(tx);
  }

  async getBlob(profileId: string, blobId: string) {
    const tx = this.db.transaction("blobs");
    const r = (await req(
      tx.objectStore("blobs").get(`${profileId}|${blobId}`),
    )) as { blob: Blob } | undefined;
    return r?.blob;
  }

  async scopes(profileId: string): Promise<ScopeState[]> {
    const tx = this.db.transaction("scopes");
    return (await req(
      tx.objectStore("scopes").index("profile").getAll(profileId),
    )) as ScopeState[];
  }
  async putScope(state: ScopeState) {
    const tx = this.db.transaction("scopes", "readwrite");
    tx.objectStore("scopes").put({
      ...state,
      key: `${state.profileId}|${state.scope}`,
    });
    await done(tx);
  }
  async deleteScope(profileId: string, scope: string) {
    const tx = this.db.transaction("scopes", "readwrite");
    tx.objectStore("scopes").delete(`${profileId}|${scope}`);
    await done(tx);
  }

  async getRef(profileId: string, scope: string) {
    const tx = this.db.transaction("refs");
    const r = (await req(
      tx.objectStore("refs").get(`${profileId}|${scope}`),
    )) as { inspectionId: string } | undefined;
    return r?.inspectionId;
  }
  async setRef(profileId: string, scope: string, inspectionId: string) {
    const tx = this.db.transaction("refs", "readwrite");
    tx.objectStore("refs").put({
      key: `${profileId}|${scope}`,
      inspectionId,
    });
    await done(tx);
  }
  async clearRef(profileId: string, scope: string) {
    const tx = this.db.transaction("refs", "readwrite");
    tx.objectStore("refs").delete(`${profileId}|${scope}`);
    await done(tx);
  }

  async getSnapshot(profileId: string) {
    const tx = this.db.transaction("snapshots");
    return (await req(tx.objectStore("snapshots").get(profileId))) as
      Snapshot | undefined;
  }
  async putSnapshot(snapshot: Snapshot) {
    const tx = this.db.transaction("snapshots", "readwrite");
    tx.objectStore("snapshots").put(snapshot);
    await done(tx);
  }
}
