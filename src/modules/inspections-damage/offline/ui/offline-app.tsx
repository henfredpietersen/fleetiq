"use client";
// The driver screens with no connection: the 24-hour snapshot (allocations, vehicles, checklist, known damage, draft state) with the
// phone's unsent queue applied. Nothing is fetched from the server here; the form writes through the same queue as online.
import Link from "next/link";
import { useMemo, useState, useSyncExternalStore } from "react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  AWAITING_CLOSURE,
  driverStatusLabel,
} from "@/modules/shifts-allocations/domain/allocation-text";
import { formatShiftWindow } from "@/modules/shifts-allocations/domain/format";
import { myInspectionDoc } from "../../domain/inspection-types";
import { InspectionForm } from "../../ui/inspection-form";
import { effectiveAllocation } from "../domain/overlay";
import { scopeOf, type Stage } from "../domain/types";
import { ACTIVE_PROFILE_KEY, ScopeStatusLine, SyncBar } from "./sync-bar";
import { useSync } from "./sync-manager";

function readActiveProfile(): string | null {
  try {
    const raw = localStorage.getItem(ACTIVE_PROFILE_KEY);
    const v = raw ? (JSON.parse(raw) as { profileId?: unknown }) : null;
    return typeof v?.profileId === "string" ? v.profileId : null;
  } catch {
    return null;
  }
}

const subscribeStorage = (cb: () => void) => {
  window.addEventListener("storage", cb);
  return () => window.removeEventListener("storage", cb);
};

export function OfflineDriverApp() {
  // undefined while rendering on the server / hydrating, then the profile that last used this phone online (null = none)
  const profileId = useSyncExternalStore<string | null | undefined>(
    subscribeStorage,
    readActiveProfile,
    () => undefined,
  );
  if (profileId === undefined)
    return (
      <p role="status" className="text-muted-foreground text-sm">
        Loading…
      </p>
    );
  if (!profileId)
    return (
      <div className="flex flex-col gap-3" data-testid="offline-no-profile">
        <Alert>
          Nothing is saved for you on this phone yet. Open FleetIQ and sign in
          once while you have a connection.
        </Alert>
        <Link
          href="/sign-in"
          className={buttonVariants({ size: "lg", className: "min-h-14" })}
        >
          Sign in
        </Link>
      </div>
    );
  return <Shell profileId={profileId} />;
}

function Shell({ profileId }: { profileId: string }) {
  const { state, manager } = useSync(profileId);
  const [open, setOpen] = useState<{ id: string; stage: Stage } | null>(null);
  const snap = state.snapshot;
  const opened = useMemo(() => {
    if (!open || !snap) return null;
    const a = snap.allocations.find((x) => x.allocation.id === open.id);
    const doc = myInspectionDoc.safeParse(a?.inspections[open.stage]);
    return doc.success ? doc.data : null;
  }, [open, snap]);

  if (!state.ready)
    return (
      <p role="status" className="text-muted-foreground text-sm">
        Loading…
      </p>
    );
  if (open && opened)
    return (
      <div className="flex flex-col gap-4" data-testid="offline-form">
        <SyncBar profileId={profileId} />
        <InspectionForm
          allocationId={open.id}
          data={opened}
          noticeAcknowledged={snap?.noticeAcknowledged ?? false}
          profileId={profileId}
          onSynced={() => void manager.refreshSnapshot()}
        />
        <Button
          type="button"
          variant="outline"
          size="lg"
          className="min-h-12 w-full"
          onClick={() => setOpen(null)}
        >
          Back to my allocations
        </Button>
      </div>
    );
  return (
    <div className="flex flex-col gap-4" data-testid="offline-list">
      <SyncBar profileId={profileId} />
      {state.online ? (
        <Link
          href="/my-allocations"
          className={buttonVariants({ size: "lg", className: "min-h-14" })}
        >
          You are back online — continue
        </Link>
      ) : null}
      {!snap || snap.allocations.length === 0 ? (
        <Alert>
          No allocations are saved on this phone for the next 24 hours.
        </Alert>
      ) : (
        <ul className="flex flex-col gap-3">
          {snap.allocations.map(({ allocation: a }) => {
            const eff = effectiveAllocation(a, state.items);
            return (
              <li
                key={a.id}
                data-testid="offline-allocation"
                className="flex flex-col gap-3 rounded-lg border p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="text-lg font-semibold">
                      {a.fleetNumber} · {a.registration}
                    </p>
                    <p className="text-muted-foreground text-sm">
                      {a.make} {a.model} · {a.branchName}
                    </p>
                  </div>
                  <Badge variant="outline">
                    {eff.status === "post_inspection_pending" &&
                    eff.postShiftSubmitted
                      ? AWAITING_CLOSURE
                      : driverStatusLabel(eff.status)}
                  </Badge>
                </div>
                <p className="text-sm">
                  Shift {formatShiftWindow(a.shiftStartAt, a.shiftEndAt)}
                </p>
                <ScopeStatusLine
                  profileId={profileId}
                  scope={scopeOf(a.id, "pre_shift")}
                />
                <ScopeStatusLine
                  profileId={profileId}
                  scope={scopeOf(a.id, "post_shift")}
                />
                {eff.status === "pre_inspection_pending" ? (
                  <Button
                    type="button"
                    size="lg"
                    className="min-h-14 w-full text-base"
                    onClick={() => setOpen({ id: a.id, stage: "pre_shift" })}
                  >
                    Pre-shift inspection
                  </Button>
                ) : null}
                {eff.status === "in_use" ? (
                  <Button
                    type="button"
                    size="lg"
                    variant="outline"
                    className="min-h-14 w-full text-base"
                    onClick={() => setOpen({ id: a.id, stage: "post_shift" })}
                  >
                    End shift — post-shift inspection
                  </Button>
                ) : null}
                {eff.status === "post_inspection_pending" &&
                !eff.postShiftSubmitted ? (
                  <Button
                    type="button"
                    size="lg"
                    className="min-h-14 w-full text-base"
                    onClick={() => setOpen({ id: a.id, stage: "post_shift" })}
                  >
                    Post-shift inspection
                  </Button>
                ) : null}
                {eff.status === "planned" ? (
                  <p
                    className="text-muted-foreground rounded-md border p-3 text-sm"
                    data-testid="start-needs-connection"
                  >
                    Starting needs a connection
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
