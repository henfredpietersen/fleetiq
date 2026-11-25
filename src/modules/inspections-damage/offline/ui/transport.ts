"use client";
// The phone's side of POST /api/inspection-sync and of the signed-URL upload. Classification lives in the domain (classify.ts).
import {
  classifyHttp,
  classifyNetworkError,
  classifyPut,
  type Outcome,
  type PutOutcome,
} from "../domain/classify";
import { OFFLINE_CONFIG } from "../domain/config";
import type { SyncOp, Transport } from "../domain/runner";

async function withTimeout<T>(
  ms: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    return await run(c.signal);
  } finally {
    clearTimeout(t);
  }
}

export function createTransport(
  profileId: string,
  fetchImpl: typeof fetch = (...a) => fetch(...a),
): Transport {
  return {
    async call(op: SyncOp, body: Record<string, unknown>): Promise<Outcome> {
      try {
        return await withTimeout(
          OFFLINE_CONFIG.requestTimeoutMs,
          async (signal) => {
            const res = await fetchImpl("/api/inspection-sync", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ ...body, op, profileId }),
              signal,
              cache: "no-store",
            });
            const json = await res.json().catch(() => null);
            return classifyHttp(res.status, json);
          },
        );
      } catch {
        return classifyNetworkError();
      }
    },
    async put(url: string, blob: Blob): Promise<PutOutcome> {
      try {
        return await withTimeout(
          OFFLINE_CONFIG.uploadTimeoutMs,
          async (signal) => {
            const body = new FormData();
            body.append("cacheControl", "3600");
            body.append("", blob);
            const res = await fetchImpl(url, { method: "PUT", body, signal });
            return classifyPut(res.status);
          },
        );
      } catch {
        return classifyPut(null);
      }
    },
  };
}
