// Which queued item is sent next. Items of ONE scope (allocation + stage) go strictly in order: the first item of a scope is the
// only one that can be sent; a later item waits for it. A scope that is waiting for its backoff, or has a conflict, is skipped
// and never blocks another inspection.
import type { QueueItem, ScopeState } from "./types";

export function groupByScope(items: QueueItem[]): Map<string, QueueItem[]> {
  const m = new Map<string, QueueItem[]>();
  for (const i of [...items].sort((a, b) => a.seq - b.seq))
    m.set(i.scope, [...(m.get(i.scope) ?? []), i]);
  return m;
}

/** A scope with a conflict stays stopped after a supervisor resolves it: only the driver's "Remove from this phone" ends it. */
export const blockedScopes = (scopes: ScopeState[]): Set<string> =>
  new Set(scopes.map((s) => s.scope));

export function pickNext(
  items: QueueItem[],
  scopes: ScopeState[],
  now: number,
): QueueItem | null {
  const blocked = blockedScopes(scopes);
  let best: QueueItem | null = null;
  for (const [scope, list] of groupByScope(items)) {
    if (blocked.has(scope)) continue;
    const first = list[0]!;
    if (first.nextAttemptAt > now) continue;
    if (!best || first.seq < best.seq) best = first;
  }
  return best;
}

/** The earliest moment any waiting scope becomes sendable again (null = nothing is waiting). */
export function nextWakeAt(
  items: QueueItem[],
  scopes: ScopeState[],
  now: number,
): number | null {
  const blocked = blockedScopes(scopes);
  let at: number | null = null;
  for (const [scope, list] of groupByScope(items)) {
    if (blocked.has(scope)) continue;
    const t = list[0]!.nextAttemptAt;
    if (t > now && (at === null || t < at)) at = t;
  }
  return at;
}
