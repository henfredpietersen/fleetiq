"use client";

import { useRef, useState, useTransition } from "react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { fromLocalInput, toLocalInput } from "../domain/format";
import { STARTED_BY_SUPERVISOR } from "../domain/allocation-text";
import {
  amendTimesAction,
  checkAmendAction,
  historyAction,
  transitionAction,
} from "../server/lifecycle-actions";
import type { HistoryEvent } from "../domain/lifecycle-types";

type Mode = "start" | "cancel" | "no_show" | "amend" | "history";

export type RowActionProps = {
  id: string;
  label: string; // "FL-001 · TEST001-GP, Driver (T0001)"
  status: string;
  plannedStartAt: string;
  plannedEndAt: string;
  openedOnBehalf: boolean;
  canManage: boolean;
  /** Computed on the server from the same settings the database uses; the database re-checks. */
  startWindowOpen: boolean;
  startOpensAtLabel: string;
  noShowOk: boolean;
  noShowFromLabel: string;
};

const EVENT_TEXT: Record<string, string> = {
  created: "Created",
  status_changed: "Status changed",
  cancelled: "Cancelled",
  amended: "Planned times changed",
};
const nice = (s: unknown) => String(s ?? "").replace(/_/g, " ");

function describe(e: HistoryEvent): string {
  if (e.eventType === "amended") return "Planned times were changed.";
  const from = e.previous?.status;
  const to = e.next?.status;
  const base = from ? `${nice(from)} → ${nice(to)}` : `Status: ${nice(to)}`;
  return e.onBehalf ? `${base} (${STARTED_BY_SUPERVISOR})` : base;
}

/** Supervisor actions for one allocation. Actions the user cannot take are not shown; the database enforces every rule. */
export function AllocationRowActions(p: RowActionProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const [mode, setMode] = useState<Mode>("start");
  const [submissionId, setSubmissionId] = useState(() => crypto.randomUUID());
  const [reason, setReason] = useState("");
  const [start, setStart] = useState(toLocalInput(p.plannedStartAt));
  const [end, setEnd] = useState(toLocalInput(p.plannedEndAt));
  const [problems, setProblems] = useState<string[] | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  const [events, setEvents] = useState<HistoryEvent[] | null>(null);
  const [busy, run] = useTransition();

  const live = p.status === "planned" || p.status === "pre_inspection_pending";
  const canStart = p.canManage && p.status === "planned";
  const canNoShow = p.canManage && p.status === "pre_inspection_pending";

  function openAs(m: Mode) {
    setMode(m);
    setMessage(null);
    setReason("");
    setProblems(null);
    setEvents(null);
    setStart(toLocalInput(p.plannedStartAt));
    setEnd(toLocalInput(p.plannedEndAt));
    ref.current?.showModal();
    if (m === "history")
      run(async () => {
        const r = await historyAction(p.id);
        if (r.ok) setEvents(r.events);
        else setMessage({ ok: false, text: r.message });
      });
  }

  const iso = () => ({ s: fromLocalInput(start), e: fromLocalInput(end) });

  function checkTimes(nextStart: string, nextEnd: string) {
    setProblems(null);
    const s = fromLocalInput(nextStart);
    const e = fromLocalInput(nextEnd);
    if (!s || !e) return;
    run(async () => {
      const r = await checkAmendAction({
        allocationId: p.id,
        plannedStartAt: s,
        plannedEndAt: e,
      });
      setProblems(r.ok ? r.problems : [r.message]);
    });
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setMessage(null);
    run(async () => {
      try {
        let r;
        if (mode === "amend") {
          const t = iso();
          if (!t.s || !t.e)
            return setMessage({ ok: false, text: "Enter both times." });
          r = await amendTimesAction({
            allocationId: p.id,
            plannedStartAt: t.s,
            plannedEndAt: t.e,
            reason,
            clientSubmissionId: submissionId,
          });
        } else {
          r = await transitionAction({
            allocationId: p.id,
            toStatus:
              mode === "start"
                ? "pre_inspection_pending"
                : mode === "cancel"
                  ? "cancelled"
                  : "no_show",
            reason,
            clientSubmissionId: submissionId,
          });
        }
        setMessage({ ok: r.ok, text: r.message });
        if (r.ok) setSubmissionId(crypto.randomUUID());
      } catch {
        // same submission id on the retry: it cannot be applied twice
        setMessage({
          ok: false,
          text: "No connection. Check your signal and submit again: it will not be applied twice.",
        });
      }
    });
  }

  const titles: Record<Mode, string> = {
    start: "Start on the driver's behalf",
    cancel: "Cancel allocation",
    no_show: "Mark as no-show",
    amend: "Amend planned times",
    history: "Status history",
  };
  const done = message?.ok === true;

  return (
    <div
      className="flex flex-wrap items-center gap-2"
      data-testid="row-actions"
    >
      {p.openedOnBehalf ? (
        <Badge variant="warning" data-testid="started-by-supervisor">
          {STARTED_BY_SUPERVISOR}
        </Badge>
      ) : null}
      {canStart && p.startWindowOpen ? (
        <Button type="button" onClick={() => openAs("start")}>
          Start on driver&apos;s behalf
        </Button>
      ) : canStart ? (
        <span className="text-muted-foreground text-xs">
          Start opens {p.startOpensAtLabel}
        </span>
      ) : null}
      {canNoShow ? (
        <Button
          type="button"

          variant="outline"
          disabled={!p.noShowOk}
          title={
            p.noShowOk
              ? undefined
              : `A no-show can only be recorded from ${p.noShowFromLabel}`
          }
          onClick={() => openAs("no_show")}
        >
          Mark no-show
        </Button>
      ) : null}
      {canNoShow && !p.noShowOk ? (
        <span className="text-muted-foreground text-xs">
          No-show allowed from {p.noShowFromLabel}
        </span>
      ) : null}
      {p.canManage && live ? (
        <>
          <Button
            type="button"

            variant="outline"
            onClick={() => openAs("amend")}
          >
            Amend times
          </Button>
          <Button
            type="button"

            variant="outline"
            onClick={() => openAs("cancel")}
          >
            Cancel
          </Button>
        </>
      ) : null}
      <Button
        type="button"

        variant="ghost"
        onClick={() => openAs("history")}
      >
        History
      </Button>

      <dialog
        ref={ref}
        aria-labelledby={`row-${p.id}`}
        className="bg-background text-foreground m-auto w-full max-w-lg rounded-lg border p-6 shadow-lg backdrop:bg-black/40"
      >
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <h2 id={`row-${p.id}`} className="text-lg font-semibold">
            {titles[mode]}
          </h2>
          <p className="text-muted-foreground text-sm">{p.label}</p>

          {mode === "history" ? (
            events === null && !message ? (
              <p className="text-muted-foreground text-sm">Loading history…</p>
            ) : events && events.length === 0 ? (
              <p className="text-muted-foreground text-sm">No history yet.</p>
            ) : (
              <ol className="flex flex-col gap-3" data-testid="history">
                {(events ?? []).map((e) => (
                  <li key={e.id} className="rounded-md border p-3 text-sm">
                    <p className="font-medium">
                      {EVENT_TEXT[e.eventType] ?? e.eventType}: {describe(e)}
                    </p>
                    <p className="text-muted-foreground">
                      {new Date(e.occurredAt).toLocaleString("en-ZA", {
                        timeZone: "Africa/Johannesburg",
                      })}{" "}
                      · {e.actorName}
                    </p>
                    {e.reason ? <p>Reason: {e.reason}</p> : null}
                  </li>
                ))}
              </ol>
            )
          ) : (
            <>
              {mode === "start" ? (
                <Alert>
                  This allocation will be started on the driver&apos;s behalf.
                  It is{" "}
                  <strong>permanently recorded as started by supervisor</strong>{" "}
                  in the history and in reports. Give the reason.
                </Alert>
              ) : null}
              {mode === "amend" ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="flex flex-col gap-1 text-sm">
                    Planned start (Africa/Johannesburg)
                    <input
                      type="datetime-local"
                      name="plannedStart"
                      value={start}
                      disabled={busy || done}
                      className="border-input h-10 rounded-md border px-2"
                      onChange={(e) => {
                        setStart(e.target.value);
                        checkTimes(e.target.value, end);
                      }}
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-sm">
                    Planned end
                    <input
                      type="datetime-local"
                      name="plannedEnd"
                      value={end}
                      disabled={busy || done}
                      className="border-input h-10 rounded-md border px-2"
                      onChange={(e) => {
                        setEnd(e.target.value);
                        checkTimes(start, e.target.value);
                      }}
                    />
                  </label>
                </div>
              ) : null}
              {mode === "amend" && problems ? (
                problems.length === 0 ? (
                  <Alert variant="success" data-testid="amend-check">
                    These times are allowed.
                  </Alert>
                ) : (
                  <Alert variant="destructive" data-testid="amend-check">
                    {problems.map((t) => (
                      <p key={t}>{t}</p>
                    ))}
                  </Alert>
                )
              ) : null}
              <label className="flex flex-col gap-1 text-sm">
                Reason (required, up to 500 characters)
                <textarea
                  name="reason"
                  required
                  maxLength={500}
                  value={reason}
                  disabled={busy || done}
                  onChange={(e) => setReason(e.target.value)}
                  className="border-input min-h-20 rounded-md border p-2"
                />
              </label>
            </>
          )}

          {message ? (
            <Alert
              variant={message.ok ? "success" : "destructive"}
              role="status"
            >
              {message.text}
            </Alert>
          ) : null}
          <div className="flex flex-wrap gap-3">
            {mode !== "history" && !done ? (
              <Button
                type="submit"
                size="lg"
                disabled={
                  busy ||
                  reason.trim() === "" ||
                  (mode === "amend" && problems !== null && problems.length > 0)
                }
              >
                {busy
                  ? "Saving…"
                  : mode === "start"
                    ? "Start on driver's behalf"
                    : mode === "cancel"
                      ? "Cancel allocation"
                      : mode === "no_show"
                        ? "Mark as no-show"
                        : "Save times"}
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="lg"
              onClick={() => ref.current?.close()}
            >
              Close
            </Button>
          </div>
        </form>
      </dialog>
    </div>
  );
}
