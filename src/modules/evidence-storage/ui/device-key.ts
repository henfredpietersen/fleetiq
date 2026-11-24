"use client";
// Client-side home of the device key (DEC-35): IndexedDB first, localStorage as a fallback, memory as a last resort. Created on
// first use. Untrusted by design — see domain/device-key.ts.
import { isDeviceKey } from "../domain/device-key";

const DB = "fleetiq-device";
const STORE = "kv";
const NAME = "device-key";
let memory: string | null = null;

function idb<T>(
  mode: IDBTransactionMode,
  run: (s: IDBObjectStore) => IDBRequest<T>,
) {
  return new Promise<T>((resolve, reject) => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction(STORE, mode);
      const req = run(tx.objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => open.result.close();
    };
  });
}

async function read(): Promise<string | null> {
  try {
    const v = await idb<unknown>("readonly", (s) => s.get(NAME));
    if (isDeviceKey(v)) return v;
  } catch {
    /* fall through */
  }
  try {
    const v = localStorage.getItem(NAME);
    if (isDeviceKey(v)) return v;
  } catch {
    /* fall through */
  }
  return memory;
}

/** The existing key, or a new random one (kept in every store that works). Never throws. */
export async function getDeviceKey(): Promise<string> {
  const have = await read();
  if (have) return have;
  const key = crypto.randomUUID();
  memory = key;
  try {
    await idb("readwrite", (s) => s.put(key, NAME));
  } catch {
    /* localStorage next */
  }
  try {
    localStorage.setItem(NAME, key);
  } catch {
    /* memory only */
  }
  return key;
}
