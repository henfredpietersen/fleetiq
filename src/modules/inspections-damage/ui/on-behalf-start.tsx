"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { beginOnBehalfAction } from "../server/damage-actions";

/**
 * DEC-09: "Complete post-shift for the driver". Shown only to people who hold allocation.manage AND inspection.submit for the
 * branch (the database re-checks both, and refuses the driver themselves). A reason is required; it is stored on the inspection,
 * shown on a permanent banner and audited. The supervisor then fills in the same stepped form, on their own phone.
 */
export function OnBehalfStart({
  allocationId,
  label,
}: {
  allocationId: string;
  label: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [submissionId, setSubmissionId] = useState(() => crypto.randomUUID());
  const [busy, run] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setMessage(null);
    run(async () => {
      try {
        const r = await beginOnBehalfAction({
          allocationId,
          reason,
          deviceStartedAt: new Date().toISOString(),
          capturedOffline: !navigator.onLine,
          clientSubmissionId: submissionId,
        });
        if (r.ok) {
          setSubmissionId(crypto.randomUUID());
          ref.current?.close();
          router.push(`/shifts/allocations/${allocationId}/on-behalf`);
        } else setMessage(r.message);
      } catch {
        // same submission id on the retry: it cannot be applied twice
        setMessage(
          "No connection. Check your signal and submit again: it will not be applied twice.",
        );
      }
    });
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        onClick={() => {
          setMessage(null);
          setReason("");
          ref.current?.showModal();
        }}
      >
        Complete post-shift for the driver
      </Button>
      <dialog
        ref={ref}
        aria-label="Complete the post-shift inspection for the driver"
        className="bg-background text-foreground m-auto w-[min(32rem,92vw)] rounded-lg border p-5 shadow-lg backdrop:bg-black/40"
      >
        <form onSubmit={submit} className="flex flex-col gap-4">
          <h2 className="text-lg font-semibold">
            Complete the post-shift inspection for the driver
          </h2>
          <p className="text-muted-foreground text-sm">{label}</p>
          <p className="text-sm">
            You will answer the checklist and take the photos yourself. The
            inspection is permanently marked as completed by a supervisor, with
            your reason. You cannot approve exceptions on it.
          </p>
          <div className="flex flex-col gap-2">
            <Label htmlFor={`ob-reason-${allocationId}`}>
              Why are you completing it for the driver?
            </Label>
            <Textarea
              id={`ob-reason-${allocationId}`}
              value={reason}
              maxLength={500}
              required
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          {message ? (
            <Alert variant="destructive" role="alert">
              {message}
            </Alert>
          ) : null}
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => ref.current?.close()}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy || reason.trim() === ""}>
              {busy ? "Starting…" : "Start completing it"}
            </Button>
          </div>
        </form>
      </dialog>
    </>
  );
}
