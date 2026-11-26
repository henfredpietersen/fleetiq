"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { saveSettingsAction } from "../server/review-actions";

export type SettingsValues = {
  vehicleCategory: string | null;
  maxKmPerAllocation: number | null;
  ocrMinConfidence: number | null;
  ocrDriverToleranceKm: number;
  unaccountedToleranceKm: number;
  preShiftLateMinutes: number;
  postShiftLateMinutes: number;
  staleReadingDays: number;
};

const FIELDS: {
  key: Exclude<keyof SettingsValues, "vehicleCategory">;
  label: string;
  help: string;
  optional?: boolean;
}[] = [
  {
    key: "maxKmPerAllocation",
    label: "Largest plausible distance per allocation (km)",
    help: 'DEC-15. Leave empty to keep the implausible-distance check switched off (it then reports "not configured").',
    optional: true,
  },
  {
    key: "ocrMinConfidence",
    label: "Minimum OCR confidence (0 to 1)",
    help: "DEC-13. Leave empty: nothing is accepted automatically while this is empty (OCR itself arrives in a later phase).",
    optional: true,
  },
  {
    key: "ocrDriverToleranceKm",
    label: "Allowed difference between OCR and the typed reading (km)",
    help: "DEC-14. Used once OCR is live.",
  },
  {
    key: "unaccountedToleranceKm",
    label: "Allowed gap since the previous allocation's last reading (km)",
    help: "DEC-16. A larger gap is flagged for review; it is never blamed on a driver.",
  },
  {
    key: "preShiftLateMinutes",
    label:
      "Pre-shift inspection is late after (minutes after the planned start)",
    help: "DEC-17.",
  },
  {
    key: "postShiftLateMinutes",
    label:
      "Post-shift inspection is late after (minutes after the planned end)",
    help: "DEC-17.",
  },
  {
    key: "staleReadingDays",
    label: "A reading is stale after (days)",
    help: "DEC-18.",
  },
];

/** Edit form: a change closes the version in effect and starts the next one, with a reason. Nothing is edited in place. */
export function SettingsForm({
  initial,
  categoryLabel,
}: {
  initial: SettingsValues;
  categoryLabel: string;
}) {
  const router = useRouter();
  const [vals, setVals] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      FIELDS.map((f) => [
        f.key,
        initial[f.key] === null ? "" : String(initial[f.key]),
      ]),
    ),
  );
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  const [submissionId, setSubmissionId] = useState(() => crypto.randomUUID());
  const [busy, run] = useTransition();
  return (
    <form
      className="flex max-w-2xl flex-col gap-4"
      aria-label={`Change the settings: ${categoryLabel}`}
      data-testid="settings-form"
      onSubmit={(e) => {
        e.preventDefault();
        setMessage(null);
        run(async () => {
          try {
            const r = await saveSettingsAction({
              vehicleCategory: initial.vehicleCategory ?? "",
              ...vals,
              reason,
              clientSubmissionId: submissionId,
            });
            setMessage({ ok: r.ok, text: r.message });
            if (r.ok) {
              setSubmissionId(crypto.randomUUID());
              setReason("");
              router.refresh();
            }
          } catch {
            setMessage({
              ok: false,
              text: "No connection. Check your signal and save again: it will not be applied twice.",
            });
          }
        });
      }}
    >
      {FIELDS.map((f) => (
        <div key={f.key} className="flex flex-col gap-1">
          <Label htmlFor={`set-${f.key}`}>{f.label}</Label>
          <Input
            id={`set-${f.key}`}
            name={f.key}
            inputMode={f.key === "ocrMinConfidence" ? "decimal" : "numeric"}
            autoComplete="off"
            value={vals[f.key]}
            required={!f.optional}
            onChange={(e) =>
              setVals((v) => ({ ...v, [f.key]: e.target.value }))
            }
          />
          <p className="text-muted-foreground text-xs">{f.help}</p>
        </div>
      ))}
      <div className="flex flex-col gap-1">
        <Label htmlFor="set-reason">Reason for the change (required)</Label>
        <Textarea
          id="set-reason"
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
          data-testid="settings-message"
        >
          {message.text}
        </Alert>
      ) : null}
      <Button
        type="submit"
        className="min-h-11 w-fit"
        disabled={busy || reason.trim() === ""}
      >
        {busy ? "Saving…" : "Save as a new version"}
      </Button>
    </form>
  );
}
