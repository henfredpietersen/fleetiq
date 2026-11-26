"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { stageLabel } from "@/modules/inspections-damage/domain/inspection-rules";
import {
  formatLocalClock,
  formatShiftDate,
} from "@/modules/shifts-allocations/domain/format";
import { localDate } from "@/modules/shifts-allocations/domain/shift-times";
import {
  checkLabel,
  type ItemResult,
  type ReviewRow,
} from "../domain/review-types";
import {
  quickCheckAcceptAction,
  sendToFullReviewAction,
} from "../server/review-actions";
import { ReadingPhoto } from "./reading-photo";

const when = (iso: string) =>
  `${formatShiftDate(localDate(new Date(iso)))} ${formatLocalClock(iso)}`;

/**
 * The quick photo check (DEC-44): the photo beside the typed reading. Select one or several and accept them in one action; the server
 * accepts each reading separately and refuses, per reading, any that changed or that you may not decide (DEC-24). "Doesn't match the
 * photo" sends one reading to the full review with a required note.
 */
export function QuickCheckList({ rows }: { rows: ReviewRow[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, run] = useTransition();
  const [submissionId, setSubmissionId] = useState(() => crypto.randomUUID());
  const [outcome, setOutcome] = useState<
    | { kind: "none" }
    | { kind: "error"; message: string }
    | { kind: "done"; accepted: number; refused: ItemResult[] }
  >({ kind: "none" });
  const decidable = rows.filter((r) => r.canDecide);
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  function accept() {
    setOutcome({ kind: "none" });
    const items = rows
      .filter((r) => selected.has(r.readingId) && r.validatedAt)
      .map((r) => ({ readingId: r.readingId, validatedAt: r.validatedAt! }));
    run(async () => {
      try {
        const r = await quickCheckAcceptAction({
          items,
          clientSubmissionId: submissionId,
        });
        if (!r.ok) {
          setOutcome({ kind: "error", message: r.message });
          return;
        }
        setSubmissionId(crypto.randomUUID());
        setSelected(new Set());
        setOutcome({
          kind: "done",
          accepted: r.accepted,
          refused: r.results.filter((x) => x.result === "refused"),
        });
        router.refresh();
      } catch {
        setOutcome({
          kind: "error",
          message:
            "No connection. Check your signal and try again: nothing is applied twice.",
        });
      }
    });
  }

  return (
    <div className="flex flex-col gap-4" data-testid="quick-check-list">
      <div className="bg-background sticky top-0 z-10 flex flex-wrap items-center gap-3 border-b py-3">
        <Button
          type="button"
          size="lg"
          className="min-h-12"
          disabled={busy || selected.size === 0}
          onClick={accept}
          data-testid="accept-selected"
        >
          {busy ? "Accepting…" : `Accept selected (${selected.size})`}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="min-h-12"
          disabled={busy || decidable.length === 0}
          onClick={() =>
            setSelected(
              selected.size === decidable.length
                ? new Set()
                : new Set(decidable.map((r) => r.readingId)),
            )
          }
        >
          {selected.size === decidable.length && decidable.length > 0
            ? "Clear selection"
            : "Select all I may check"}
        </Button>
        <p className="text-muted-foreground text-sm">
          Check each photo against the number the driver typed. Accepting uses
          the driver&apos;s number.
        </p>
      </div>

      {outcome.kind === "error" ? (
        <Alert variant="destructive" role="alert">
          {outcome.message}
        </Alert>
      ) : null}
      {outcome.kind === "done" ? (
        <div className="flex flex-col gap-2" data-testid="quick-check-result">
          {outcome.accepted > 0 ? (
            <Alert variant="success" role="status">
              {outcome.accepted === 1
                ? "1 reading accepted."
                : `${outcome.accepted} readings accepted.`}
            </Alert>
          ) : null}
          {outcome.refused.map((r, i) => (
            <Alert
              key={`${r.readingId}-${i}`}
              variant="destructive"
              role="alert"
              data-testid="quick-check-refused"
            >
              One reading was not accepted ({r.code}): {r.message}
            </Alert>
          ))}
        </div>
      ) : null}

      <ul className="flex flex-col gap-4">
        {rows.map((r) => (
          <QuickCard
            key={r.readingId}
            row={r}
            checked={selected.has(r.readingId)}
            onToggle={() => toggle(r.readingId)}
            disabled={busy}
          />
        ))}
      </ul>
    </div>
  );
}

function QuickCard({
  row: r,
  checked,
  onToggle,
  disabled,
}: {
  row: ReviewRow;
  checked: boolean;
  onToggle: () => void;
  disabled: boolean;
}) {
  const router = useRouter();
  const [mismatch, setMismatch] = useState(false);
  const [note, setNote] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  const [submissionId] = useState(() => crypto.randomUUID());
  const [busy, run] = useTransition();
  const neutral = r.checks.filter(
    (c) => c.result === "not_configured" || c.result === "waiting",
  );
  const blocked = !r.canDecide;
  return (
    <li
      data-testid="quick-card"
      data-reading-id={r.readingId}
      className={`grid gap-4 rounded-lg border p-4 md:grid-cols-2 ${blocked ? "opacity-70" : ""}`}
    >
      <ReadingPhoto
        evidenceFileId={r.evidenceFileId}
        readingId={r.readingId}
        label={`Odometer photo of ${r.registration}`}
      />
      <div className="flex flex-col gap-3">
        <div>
          <p className="text-muted-foreground text-sm">Typed by the driver</p>
          <p
            className="text-5xl font-bold tracking-wider"
            data-testid="typed-reading"
            data-km={r.driverReadingKm ?? ""}
          >
            {r.driverReadingKm ?? "—"}{" "}
            <span className="text-2xl font-medium">km</span>
          </p>
        </div>
        <p className="font-medium">
          {r.fleetNumber} · {r.registration}
        </p>
        <p className="text-sm">
          {stageLabel(r.stage)} · planned {when(r.plannedStartAt)} –{" "}
          {formatLocalClock(r.plannedEndAt)} · {r.branchName}
          {r.driverName ? ` · ${r.driverName}` : ""}
        </p>
        <p className="text-sm" data-testid="previous-reading">
          {r.previousAcceptedKm != null
            ? `Previous accepted reading of this vehicle: ${r.previousAcceptedKm} km${r.previousAcceptedAt ? ` (${when(r.previousAcceptedAt)})` : ""}`
            : "No earlier accepted reading of this vehicle."}
        </p>
        {r.capturedOffline ? (
          <Badge variant="outline" className="w-fit">
            Captured offline
          </Badge>
        ) : null}
        {neutral.length > 0 ? (
          <ul
            className="text-muted-foreground list-disc pl-5 text-sm"
            data-testid="neutral-notes"
          >
            {neutral.map((c) => (
              <li key={c.key}>
                {checkLabel(c.key)}:{" "}
                {c.result === "not_configured"
                  ? "not configured, so not checked"
                  : "waiting for an earlier reading to be accepted"}
              </li>
            ))}
          </ul>
        ) : null}
        <div className="flex items-center gap-2">
          <input
            id={`sel-${r.readingId}`}
            type="checkbox"
            className="size-6"
            checked={checked}
            disabled={disabled || blocked}
            onChange={onToggle}
            aria-label={`Select the reading of ${r.registration} to accept`}
          />
          <Label htmlFor={`sel-${r.readingId}`} className="text-base">
            Select to accept
          </Label>
        </div>
        {blocked ? (
          <Alert role="status" data-testid="blocked-reason">
            {r.blockedReason ?? "You are not allowed to check this reading."}
          </Alert>
        ) : null}
        {message ? (
          <Alert variant={message.ok ? "success" : "destructive"} role="status">
            {message.text}
          </Alert>
        ) : null}
        {!mismatch ? (
          <Button
            type="button"
            variant="outline"
            className="min-h-12 w-fit"
            disabled={disabled || blocked}
            onClick={() => setMismatch(true)}
          >
            Doesn&apos;t match the photo
          </Button>
        ) : (
          <form
            className="flex flex-col gap-2 rounded-lg border p-3"
            aria-label="Doesn't match the photo"
            onSubmit={(e) => {
              e.preventDefault();
              setMessage(null);
              run(async () => {
                try {
                  const x = await sendToFullReviewAction({
                    readingId: r.readingId,
                    note,
                    clientSubmissionId: submissionId,
                  });
                  setMessage({ ok: x.ok, text: x.message });
                  if (x.ok) router.refresh();
                } catch {
                  setMessage({
                    ok: false,
                    text: "No connection. Check your signal and try again: nothing is applied twice.",
                  });
                }
              });
            }}
          >
            <Label htmlFor={`note-${r.readingId}`}>
              What does the photo show? (required)
            </Label>
            <Textarea
              id={`note-${r.readingId}`}
              value={note}
              maxLength={500}
              required
              onChange={(e) => setNote(e.target.value)}
            />
            <div className="flex gap-2">
              <Button type="submit" disabled={busy || note.trim() === ""}>
                {busy ? "Sending…" : "Send to full review"}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => setMismatch(false)}
              >
                Cancel
              </Button>
            </div>
          </form>
        )}
      </div>
    </li>
  );
}
