"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { voidInspectionAction } from "../server/damage-actions";

/** Void an inspection (allocation.manage, with a reason). Shown only to people other than the one who completed it (DEC-24); the
 *  database refuses the completer anyway. Nothing is deleted. */
export function VoidInspection({ inspectionId }: { inspectionId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  const [submissionId, setSubmissionId] = useState(() => crypto.randomUUID());
  const [busy, run] = useTransition();
  if (!open)
    return (
      <Button
        type="button"
        variant="outline"
        className="w-fit"
        onClick={() => setOpen(true)}
      >
        Void this inspection
      </Button>
    );
  return (
    <form
      className="flex max-w-lg flex-col gap-3 rounded-lg border p-4"
      aria-label="Void this inspection"
      onSubmit={(e) => {
        e.preventDefault();
        setMessage(null);
        run(async () => {
          try {
            const r = await voidInspectionAction({
              inspectionId,
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
              text: "No connection. Check your signal and submit again: it will not be applied twice.",
            });
          }
        });
      }}
    >
      <Label htmlFor="void-reason">Reason for voiding</Label>
      <Textarea
        id="void-reason"
        value={reason}
        maxLength={500}
        required
        onChange={(e) => setReason(e.target.value)}
      />
      {message ? (
        <Alert variant={message.ok ? "success" : "destructive"} role="status">
          {message.text}
        </Alert>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" disabled={busy || reason.trim() === ""}>
          {busy ? "Voiding…" : "Void"}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => setOpen(false)}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
