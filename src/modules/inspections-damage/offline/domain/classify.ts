// Error classification for queued writes (DEC-06, DEC-43). ONE place decides what is retried and what is a conflict.
//   retry    network failure, timeout, 408/425/429, any 5xx, a response that is not our JSON            -> wait (backoff), same csid
//   auth     401, or the server says the session belongs to someone else                              -> pause until the next sign-in
//   refused  any other answer the server gave on purpose (403, 404, 409, 422, 400 ...: stable SQLSTATE / IN0xx / DM0xx / EV0xx,
//            "already used for a different request")                                                    -> CONFLICT: stop that inspection's
//            queue, keep everything, show the server's message as is, report it
// Nothing is ever dropped or rewritten because of an error.
import { OFFLINE_CONFIG } from "./config";

export type Outcome =
  | { kind: "ok"; data: Record<string, unknown> }
  | { kind: "retry"; message: string }
  | { kind: "auth"; message: string }
  | { kind: "refused"; code: string; message: string; status: number };

export const NETWORK_MESSAGE =
  "No connection to the server. It will be sent when the connection is back.";

export function classifyHttp(status: number, body: unknown): Outcome {
  const b =
    body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  const message =
    typeof b?.message === "string" && b.message
      ? b.message
      : `The server answered ${status}.`;
  const code =
    typeof b?.code === "string" && b.code ? b.code : `HTTP ${status}`;
  if (status >= 200 && status < 300) {
    return b && b.ok === true
      ? { kind: "ok", data: b }
      : { kind: "retry", message: "The server's answer was not understood." };
  }
  if (status === 401) return { kind: "auth", message };
  if (status === 408 || status === 425 || status === 429 || status >= 500)
    return { kind: "retry", message };
  return { kind: "refused", code, message, status };
}

/** fetch threw (offline, DNS, reset, aborted by the timeout): never a refusal. */
export const classifyNetworkError = (): Outcome => ({
  kind: "retry",
  message: NETWORK_MESSAGE,
});

/** The signed upload URL: an old/expired URL is answered 400/401/403/404 by storage; those mean "ask for a new slot". */
export type PutOutcome = "ok" | "retry" | "expired";
export function classifyPut(status: number | null): PutOutcome {
  if (status === null) return "retry";
  if (status >= 200 && status < 300) return "ok";
  if (status === 400 || status === 401 || status === 403 || status === 404)
    return "expired";
  return "retry";
}

/** Exponential backoff: base * factor^(attempts - 1), capped. `attempts` counts failed attempts so far (>= 1). */
export function backoffMs(
  attempts: number,
  cfg: {
    baseMs: number;
    factor: number;
    maxMs: number;
  } = OFFLINE_CONFIG.backoff,
): number {
  const n = Math.max(1, Math.floor(attempts));
  return Math.min(cfg.maxMs, cfg.baseMs * cfg.factor ** (n - 1));
}
