"use client";

import { useRef, useState, useTransition } from "react";
import Link from "next/link";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  driverStatusLabel,
  STARTED_BY_SUPERVISOR,
} from "../domain/allocation-text";
import { formatShiftWindow } from "../domain/format";
import { transitionAction } from "../server/lifecycle-actions";
import type { MyAllocation } from "../domain/lifecycle-types";

/**
 * One allocation for the driver (mobile first: large tap targets). "Start" calls transition_allocation; the database
 * decides (window, licence, shift). The submission id is created once per card and reused on every retry, so a dropped
 * connection followed by a second tap cannot start twice. The database's refusal message is shown as is.
 */
export function MyAllocationCard({ a }: { a: MyAllocation }) {
  const submissionId = useRef(crypto.randomUUID());
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState(a.status);
  const [canOpen, setCanOpen] = useState(a.canOpen);
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
          {driverStatusLabel(status)}
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
      {status === "post_inspection_pending" ? (
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
      {canOpen && status === "planned" ? (
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
