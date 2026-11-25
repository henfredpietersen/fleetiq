"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { digitsOnly } from "../domain/reading-input";
import { reviewReadingAction } from "../server/review-actions";

type Decision = "accept" | "accept_value" | "reject";

/**
 * The full-review decision (odometer.exception.approve): accept the driver's reading, accept a different value (the driver's value is
 * never edited: yours is stored separately) or reject. A reason is always required. Shown only to someone who may decide this reading
 * (DEC-24: never one you entered, completed or drove); the database refuses everyone else anyway.
 */
export function FullReviewDecision({
  readingId,
  driverKm,
  canDecide,
  blockedReason,
}: {
  readingId: string;
  driverKm: number | null;
  canDecide: boolean;
  blockedReason: string | null;
}) {
  const router = useRouter();
  const [decision, setDecision] = useState<Decision>("accept");
  const [km, setKm] = useState("");
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  const [submissionId, setSubmissionId] = useState(() => crypto.randomUUID());
  const [busy, run] = useTransition();
  if (!canDecide)
    return (
      <Alert role="status" data-testid="cannot-decide">
        {blockedReason ??
          "You can look at this reading, but deciding a full review needs the permission to approve odometer exceptions for this branch."}
      </Alert>
    );
  const kmOk = decision !== "accept_value" || /^[0-9]{1,7}$/.test(km);
  return (
    <form
      className="flex max-w-xl flex-col gap-4 rounded-lg border p-4"
      aria-label="Decide this reading"
      data-testid="decision-form"
      onSubmit={(e) => {
        e.preventDefault();
        setMessage(null);
        run(async () => {
          try {
            const r = await reviewReadingAction({
              readingId,
              decision,
              acceptedKm: decision === "accept_value" ? Number(km) : null,
              reason,
              clientSubmissionId: submissionId,
            });
            setMessage({ ok: r.ok, text: r.message });
            if (r.ok) {
              setSubmissionId(crypto.randomUUID());
              router.refresh();
            }
          } catch {
            setMessage({
              ok: false,
              text: "No connection. Check your signal and try again: nothing is applied twice.",
            });
          }
        });
      }}
    >
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 font-medium">Your decision</legend>
        {(
          [
            ["accept", `Accept the driver's reading (${driverKm ?? "—"} km)`],
            ["accept_value", "Accept a different value (what the photo shows)"],
            ["reject", "Reject this reading"],
          ] as [Decision, string][]
        ).map(([v, label]) => (
          <label key={v} className="flex items-center gap-3 text-base">
            <input
              type="radio"
              name="decision"
              value={v}
              className="size-5"
              checked={decision === v}
              onChange={() => setDecision(v)}
            />
            {label}
          </label>
        ))}
      </fieldset>
      {decision === "accept_value" ? (
        <div className="flex flex-col gap-2">
          <Label htmlFor="accepted-km">Reading shown in the photo (km)</Label>
          <Input
            id="accepted-km"
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete="off"
            value={km}
            onChange={(e) => setKm(digitsOnly(e.target.value))}
            className="h-14 text-2xl"
            required
          />
          <p className="text-muted-foreground text-sm">
            The driver&apos;s typed value stays as entered; this value is stored
            beside it.
          </p>
        </div>
      ) : null}
      <div className="flex flex-col gap-2">
        <Label htmlFor="decision-reason">
          Reason (required)
          {decision === "accept_value" ? " — say what the photo shows" : ""}
        </Label>
        <Textarea
          id="decision-reason"
          value={reason}
          maxLength={500}
          required
          onChange={(e) => setReason(e.target.value)}
        />
      </div>
      {message ? (
        <Alert
          variant={message.ok ? "success" : "destructive"}
          role="status"
          data-testid="decision-message"
        >
          {message.text}
        </Alert>
      ) : null}
      <Button
        type="submit"
        size="lg"
        className="min-h-12 w-fit"
        disabled={busy || reason.trim() === "" || !kmOk}
      >
        {busy ? "Saving…" : "Save decision"}
      </Button>
    </form>
  );
}
