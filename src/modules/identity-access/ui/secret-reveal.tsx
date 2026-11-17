"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * Shows a temporary PIN / password exactly once, in a modal the issuer must dismiss. The value lives only in this
 * component's props: it is not written to the URL, local storage or any log, and once dismissed it is gone —
 * the server never stores it, so it cannot be shown again (reset to get a new one).
 */
export function SecretReveal({
  title,
  label,
  value,
  note,
}: {
  title: string;
  label: string;
  value: string;
  note: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(true);
  const [copied, setCopied] = useState<"idle" | "done" | "failed">("idle");

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && open && !dialog.open) dialog.showModal();
  }, [open]);

  if (!open) return null;

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied("done");
    } catch {
      setCopied("failed");
    }
  }

  return (
    <dialog
      ref={ref}
      aria-labelledby="secret-title"
      className="bg-background text-foreground m-auto w-full max-w-md rounded-lg border p-6 shadow-lg backdrop:bg-black/50"
      onCancel={(e) => e.preventDefault()} // must be dismissed with the button, so it is not lost by accident
    >
      <h2 id="secret-title" className="text-lg font-semibold">
        {title}
      </h2>
      <p className="text-muted-foreground mt-1 text-sm">{note}</p>
      <p className="mt-4 text-xs font-medium tracking-wide uppercase">
        {label}
      </p>
      <p
        className="bg-muted mt-1 rounded-md px-3 py-3 font-mono text-xl tracking-widest break-all select-all"
        data-testid="revealed-secret"
      >
        {value}
      </p>
      <p className="text-muted-foreground mt-3 text-sm" aria-live="polite">
        {copied === "done"
          ? "Copied to the clipboard."
          : copied === "failed"
            ? "Could not copy automatically. Select it and copy it by hand."
            : "Shown once. It is not stored and cannot be shown again."}
      </p>
      <div className="mt-5 flex gap-3">
        <Button type="button" variant="outline" onClick={copy}>
          Copy
        </Button>
        <Button
          type="button"
          onClick={() => {
            ref.current?.close();
            setOpen(false);
          }}
        >
          I have noted it
        </Button>
      </div>
    </dialog>
  );
}
