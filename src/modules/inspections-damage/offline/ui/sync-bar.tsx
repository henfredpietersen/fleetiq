"use client";
// The driver's connection banner, the per-inspection conflict panels, the storage warnings and the service worker registration.
// Rendered at the top of every driver screen (my allocations, the inspection, home, the offline shell). Wording: BANNER_TEXT.
import { useEffect, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  bannerFor,
  describeItems,
  SCOPE_STATUS_TEXT,
  scopeStatus,
} from "../domain/status";
import type { ScopeState } from "../domain/types";
import { useSync } from "./sync-manager";

export const ACTIVE_PROFILE_KEY = "fleetiq:active-profile";

/** Registers the service worker (public/sw.js). Without one everything still works online. */
export function registerServiceWorker() {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator))
    return;
  void navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
    /* no service worker: everything still works online */
  });
}

/** Asks the worker to keep the offline shell and the scripts it needs. Once per tab session, only while idle and online. */
function warmOfflineShell() {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator))
    return;
  try {
    if (sessionStorage.getItem("fleetiq:shell-warmed")) return;
    sessionStorage.setItem("fleetiq:shell-warmed", "1");
  } catch {
    /* private mode: warm anyway */
  }
  void navigator.serviceWorker.ready
    .then((reg) => reg.active?.postMessage({ type: "warm" }))
    .catch(() => undefined);
}

/** How long a screen sits idle before the offline shell is fetched, so it never competes with the driver's own requests. */
const WARM_AFTER_MS = 20_000;

function ConflictPanel({
  s,
  label,
  onRemove,
}: {
  s: ScopeState;
  label: string;
  onRemove: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const { state } = useSync(s.profileId);
  const items = state.items.filter((i) => i.scope === s.scope);
  return (
    <Alert
      variant="destructive"
      role="alert"
      data-testid="sync-conflict"
      className="flex flex-col gap-2"
    >
      <p className="font-medium">
        {label}: the server could not accept this inspection.
      </p>
      <p data-testid="sync-conflict-message">{s.message}</p>
      <p className="text-sm">
        Everything you did is still on this phone.{" "}
        {s.status === "resolved"
          ? `Your supervisor has resolved this${s.resolutionNote ? `: ${s.resolutionNote}` : "."}`
          : s.reported
            ? "Your supervisor has been told and will resolve it."
            : "Your supervisor will be told as soon as the phone has a connection."}
      </p>
      {s.status === "resolved" ? (
        confirming ? (
          <div className="flex flex-col gap-2" data-testid="remove-confirm">
            <p className="text-sm">
              This removes from this phone:{" "}
              {describeItems(items).join(", ") || "nothing"}. Nothing on the
              server is changed.
            </p>
            <Button
              type="button"
              size="lg"
              className="min-h-12"
              onClick={onRemove}
            >
              Remove from this phone
            </Button>
            <Button
              type="button"
              variant="outline"
              size="lg"
              className="min-h-12"
              onClick={() => setConfirming(false)}
            >
              Keep it
            </Button>
          </div>
        ) : (
          <Button
            type="button"
            size="lg"
            variant="outline"
            className="min-h-12"
            onClick={() => setConfirming(true)}
          >
            Remove from this phone…
          </Button>
        )
      ) : null}
    </Alert>
  );
}

export function SyncBar({ profileId }: { profileId: string }) {
  const { state, manager } = useSync(profileId);
  useEffect(() => {
    registerServiceWorker();
    try {
      localStorage.setItem(
        ACTIVE_PROFILE_KEY,
        JSON.stringify({ profileId, at: new Date().toISOString() }),
      );
    } catch {
      /* private mode: the offline shell then asks to sign in with a connection first */
    }
  }, [profileId]);
  const idle = state.ready && state.online && state.items.length === 0;
  useEffect(() => {
    if (!idle) return;
    const t = setTimeout(warmOfflineShell, WARM_AFTER_MS);
    return () => clearTimeout(t);
  }, [idle]);

  const banner = bannerFor({
    online: state.online,
    items: state.items,
    scopes: state.scopes,
    now: state.now,
    sending: state.sendingScope !== null,
    sentThisRun: state.sentThisRun,
    totalThisRun: state.totalThisRun,
    allSentRecently: state.allSentRecently,
  });
  const snap = state.snapshot;
  const label = (allocationId: string) => {
    const a = snap?.allocations.find(
      (x) => x.allocation.id === allocationId,
    )?.allocation;
    return a ? `${a.fleetNumber} · ${a.registration}` : "This inspection";
  };
  return (
    <div className="flex flex-col gap-2" data-testid="sync-bar">
      {!state.persistent ? (
        <Alert
          className="border-amber-600/40 text-amber-800"
          role="status"
          data-testid="sync-no-storage"
        >
          This phone cannot keep your work while it is offline. Stay in signal
          until it has been sent.
        </Alert>
      ) : null}
      {state.storageFull ? (
        <Alert
          variant="destructive"
          role="alert"
          data-testid="sync-storage-full"
        >
          This phone&apos;s storage is full, so the last item could not be
          saved. Free some space (delete photos or apps you do not need) and try
          again.
        </Alert>
      ) : null}
      {state.authRequired ? (
        <Alert
          className="border-amber-600/40 text-amber-800"
          role="status"
          data-testid="sync-auth"
        >
          Sign in again to send what is saved on this phone. It is kept safely
          until you do.
        </Alert>
      ) : null}
      {banner.kind !== "none" ? (
        <p
          role="status"
          aria-live="polite"
          data-testid="sync-banner"
          data-kind={banner.kind}
          className={
            "rounded-md border px-3 py-2 text-sm font-medium " +
            (banner.kind === "stuck" || banner.kind === "conflict"
              ? "border-amber-600/40 text-amber-800"
              : banner.kind === "all_sent"
                ? "border-green-600/40 text-green-800"
                : "")
          }
        >
          {banner.text}
        </p>
      ) : null}
      {snap ? (
        <p
          className="text-muted-foreground text-xs"
          data-testid="sync-last-updated"
        >
          Last updated{" "}
          {new Date(snap.generatedAt).toLocaleTimeString("en-ZA", {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </p>
      ) : null}
      {state.scopes.map((s) => (
        <ConflictPanel
          key={s.scope}
          s={s}
          label={label(s.allocationId)}
          onRemove={() => void manager.removeScope(s.scope)}
        />
      ))}
    </div>
  );
}

/** One short line for an inspection card: "Saved on this phone — not sent yet" etc.; empty when everything is on the server. */
export function ScopeStatusLine({
  profileId,
  scope,
}: {
  profileId: string;
  scope: string;
}) {
  const { state } = useSync(profileId);
  const st = scopeStatus(scope, state.items, state.scopes, state.sendingScope);
  if (st === "synced") return null;
  return (
    <p
      className="text-sm font-medium"
      data-testid="scope-status"
      data-status={st}
    >
      {SCOPE_STATUS_TEXT[st]}
    </p>
  );
}
