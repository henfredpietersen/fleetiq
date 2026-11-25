"use client";

import { useRef, useState, useTransition } from "react";
import Link from "next/link";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  AWAITING_CLOSURE,
  driverStatusLabel,
  STARTED_BY_SUPERVISOR,
} from "../domain/allocation-text";
import { formatShiftWindow } from "../domain/format";
import { effectiveAllocation } from "@/modules/inspections-damage/offline/domain/overlay";
import { ScopeStatusLine } from "@/modules/inspections-damage/offline/ui/sync-bar";
import { useSync } from "@/modules/inspections-damage/offline/ui/sync-manager";
import { transitionAction } from "../server/lifecycle-actions";
import type { MyAllocation } from "../domain/lifecycle-types";

/**
 * One allocation for the driver (mobile first: large tap targets). "Start" calls transition_allocation; the database
 * decides (window, licence, shift). The submission id is created once per card and reused on every retry, so a dropped
 * connection followed by a second tap cannot start twice. The database's refusal message is shown as is.
 */
export function MyAllocationCard({
  a,
  profileId,
}: {
  a: MyAllocation;
  profileId: string;
}) {
  const submissionId = useRef(crypto.randomUUID());
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [serverStatus, setStatus] = useState(a.status);
  const [canOpen, setCanOpen] = useState(a.canOpen);
  const { state, manager } = useSync(profileId);
  // unsent inspections move the card on, marked "not sent yet" (the phone's queue is the record of that work)
  const eff = effectiveAllocation(
    {
      id: a.id,
      status: serverStatus,
      postShiftSubmitted: a.postShiftSubmitted,
    },
    state.items,
  );
  const status = eff.status;
  const postShiftSubmitted = eff.postShiftSubmitted;
  const started = status === "pre_inspection_pending";

  function open() {
    setError(null);
    start(async () => {
      try {
        const r = await transitionAction({
          allocationId: a.id,
          toStatus: "pre_inspection_pending",
          clientSubmissionId: submissionId.current,
        });
        if (r.ok) {
          setStatus("pre_inspection_pending");
          setCanOpen(false);
          void manager.refreshSnapshot(); // the phone keeps this allocation's checklist and known damage from now on
        } else setError(r.message);
      } catch {
        setError(
          "No connection. Check your signal and tap Start again: it will not start twice.",
        );
      }
    });
  }

  return (
    <li
      data-testid="my-allocation"
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
        <Badge variant="outline" data-testid="allocation-status">
          {status === "post_inspection_pending" && postShiftSubmitted
            ? AWAITING_CLOSURE
            : driverStatusLabel(status)}
        </Badge>
      </div>
      <p className="text-sm">
        Shift {formatShiftWindow(a.shiftStartAt, a.shiftEndAt)}
      </p>
      {a.openedOnBehalf && started ? (
        <Badge variant="warning" data-testid="started-by-supervisor">
          {STARTED_BY_SUPERVISOR}
        </Badge>
      ) : null}
      {a.openedOnBehalf && !started && status !== "planned" ? (
        <Badge variant="warning">{STARTED_BY_SUPERVISOR}</Badge>
      ) : null}
      <ScopeStatusLine profileId={profileId} scope={`${a.id}:pre_shift`} />
      <ScopeStatusLine profileId={profileId} scope={`${a.id}:post_shift`} />
      {started ? (
        <Link
          href={`/my-allocations/${a.id}/inspection/pre-shift`}
          data-testid="pre-shift-inspection-link"
          className={buttonVariants({
            size: "lg",
            className: "min-h-14 w-full text-base",
          })}
        >
          Pre-shift inspection
        </Link>
      ) : null}
      {status === "in_use" ? (
        <Link
          href={`/my-allocations/${a.id}/inspection/post-shift`}
          data-testid="post-shift-inspection-link"
          className={buttonVariants({
            size: "lg",
            variant: "outline",
            className: "min-h-14 w-full text-base",
          })}
        >
          End shift — post-shift inspection
        </Link>
      ) : null}
      {status === "post_inspection_pending" && !postShiftSubmitted ? (
        <Link
          href={`/my-allocations/${a.id}/inspection/post-shift`}
          data-testid="post-shift-inspection-link"
          className={buttonVariants({
            size: "lg",
            className: "min-h-14 w-full text-base",
          })}
        >
          Post-shift inspection
        </Link>
      ) : null}
      {error ? <Alert variant="destructive">{error}</Alert> : null}
      {canOpen && status === "planned" && !state.online ? (
        // DEC-40: starting an allocation needs a connection (the inspection can then be completed offline)
        <p
          className="text-muted-foreground rounded-md border p-3 text-sm"
          data-testid="start-needs-connection"
        >
          Starting needs a connection
        </p>
      ) : null}
      {canOpen && status === "planned" && state.online ? (
        <Button
          type="button"
          size="lg"
          className="min-h-14 w-full text-base"
          disabled={pending}
          onClick={open}
        >
          {pending ? "Starting…" : error ? "Try again" : "Start"}
        </Button>
      ) : null}
    </li>
  );
}
