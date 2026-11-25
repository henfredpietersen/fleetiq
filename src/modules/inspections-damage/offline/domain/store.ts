// The phone's storage, as an interface (the browser uses IndexedDB; tests use the in-memory store). Everything is keyed by profile id:
// there is no call that reads across profiles.
import type { QueueItem, ScopeState, Snapshot } from "./types";

export type NewItem = Omit<QueueItem, "seq">;

export interface QueueStore {
  list(profileId: string): Promise<QueueItem[]>;
  /** Stores the item with the next sequence number and its photo blobs in one step. */
  add(item: NewItem, blobs?: { id: string; blob: Blob }[]): Promise<QueueItem>;
  update(item: QueueItem): Promise<void>;
  /** Removes the items and the photo blobs they own. Called only after the server has confirmed. */
  remove(profileId: string, itemIds: string[]): Promise<void>;
  getBlob(profileId: string, blobId: string): Promise<Blob | undefined>;
  scopes(profileId: string): Promise<ScopeState[]>;
  putScope(state: ScopeState): Promise<void>;
  deleteScope(profileId: string, scope: string): Promise<void>;
  getRef(profileId: string, scope: string): Promise<string | undefined>;
  setRef(profileId: string, scope: string, inspectionId: string): Promise<void>;
  clearRef(profileId: string, scope: string): Promise<void>;
  getSnapshot(profileId: string): Promise<Snapshot | undefined>;
  putSnapshot(snapshot: Snapshot): Promise<void>;
}

/** The photo blobs an item owns. */
export function blobIdsOf(item: QueueItem): string[] {
  const p = item.payload;
  if (p.kind === "photo") return [p.photo.blobId];
  if (p.kind === "report_damage") return p.photos.map((x) => x.photo.blobId);
  return [];
}

/** In-memory store for unit tests (and the fallback when IndexedDB is unavailable: the online flow keeps working). */
export class MemoryStore implements QueueStore {
  private items: QueueItem[] = [];
  private blobs = new Map<string, Blob>();
  private scopeStates: ScopeState[] = [];
  private refs = new Map<string, string>();
  private snapshots = new Map<string, Snapshot>();
  private seq = 0;

  async list(profileId: string) {
    return this.items
      .filter((i) => i.profileId === profileId)
      .sort((a, b) => a.seq - b.seq)
      .map((i) => structuredClone(i));
  }
  async add(item: NewItem, blobs: { id: string; blob: Blob }[] = []) {
    const stored = { ...structuredClone(item), seq: ++this.seq } as QueueItem;
    this.items.push(stored);
    for (const b of blobs) this.blobs.set(`${item.profileId}|${b.id}`, b.blob);
    return structuredClone(stored);
  }
  async update(item: QueueItem) {
    const n = this.items.findIndex(
      (i) => i.id === item.id && i.profileId === item.profileId,
    );
    if (n >= 0) this.items[n] = structuredClone(item);
  }
  async remove(profileId: string, itemIds: string[]) {
    const gone = this.items.filter(
      (i) => i.profileId === profileId && itemIds.includes(i.id),
    );
    this.items = this.items.filter((i) => !gone.includes(i));
    for (const g of gone)
      for (const b of blobIdsOf(g)) this.blobs.delete(`${profileId}|${b}`);
  }
  async getBlob(profileId: string, blobId: string) {
    return this.blobs.get(`${profileId}|${blobId}`);
  }
  async scopes(profileId: string) {
    return this.scopeStates
      .filter((s) => s.profileId === profileId)
      .map((s) => structuredClone(s));
  }
  async putScope(state: ScopeState) {
    this.scopeStates = [
      ...this.scopeStates.filter(
        (s) => !(s.profileId === state.profileId && s.scope === state.scope),
      ),
      structuredClone(state),
    ];
  }
  async deleteScope(profileId: string, scope: string) {
    this.scopeStates = this.scopeStates.filter(
      (s) => !(s.profileId === profileId && s.scope === scope),
    );
  }
  async getRef(profileId: string, scope: string) {
    return this.refs.get(`${profileId}|${scope}`);
  }
  async setRef(profileId: string, scope: string, inspectionId: string) {
    this.refs.set(`${profileId}|${scope}`, inspectionId);
  }
  async clearRef(profileId: string, scope: string) {
    this.refs.delete(`${profileId}|${scope}`);
  }
  async getSnapshot(profileId: string) {
    return this.snapshots.get(profileId);
  }
  async putSnapshot(snapshot: Snapshot) {
    this.snapshots.set(snapshot.profileId, structuredClone(snapshot));
  }
  /** test helper: how many blobs are stored for a profile */
  blobCount(profileId: string) {
    return [...this.blobs.keys()].filter((k) => k.startsWith(`${profileId}|`))
      .length;
  }
}
