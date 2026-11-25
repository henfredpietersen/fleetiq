"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { resolveSyncConflictAction } from "../server/conflict-actions";

/** Resolve a sync conflict with a note (1-500 characters). The database refuses your own report (DEC-24). */
export function ResolveConflict({ conflictId }: { conflictId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  const [submissionId] = useState(() => crypto.randomUUID());
  const [busy, run] = useTransition();
  if (!open)
    return (
      <Button
        type="button"
        variant="outline"
        className="w-fit"
        onClick={() => setOpen(true)}
      >
        Resolve
      </Button>
    );
  return (
    <form
      className="flex max-w-lg flex-col gap-3 rounded-lg border p-3"
      aria-label="Resolve this sync conflict"
      onSubmit={(e) => {
        e.preventDefault();
        setMessage(null);
        run(async () => {
          try {
            const r = await resolveSyncConflictAction({
              id: conflictId,
              note,
              clientSubmissionId: submissionId,
            });
            setMessage({ ok: r.ok, text: r.message });
            if (r.ok) router.refresh();
          } catch {
            setMessage({
              ok: false,
              text: "No connection. Check your signal and submit again: it will not be applied twice.",
            });
          }
        });
      }}
    >
      <Label htmlFor={`note-${conflictId}`}>
        What was decided? (reason, shown to the driver)
      </Label>
      <Textarea
        id={`note-${conflictId}`}
        value={note}
        maxLength={500}
        onChange={(e) => setNote(e.target.value)}
      />
      {message ? (
        <Alert variant={message.ok ? "success" : "destructive"} role="status">
          {message.text}
        </Alert>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" disabled={busy || note.trim().length === 0}>
          {busy ? "Saving…" : "Resolve"}
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
