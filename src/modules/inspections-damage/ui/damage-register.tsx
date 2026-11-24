"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  markDamageRepairedAction,
  openDamagePhotoAction,
  reviewDamageAction,
} from "../server/damage-actions";
import { damageStatusLabel, severityLabel } from "../domain/damage-zones";
import { DamageReporter } from "./damage-report";
import type { DamageRegisterItem } from "../domain/inspection-types";

const when = (iso: string) =>
  new Intl.DateTimeFormat("en-ZA", {
    timeZone: "Africa/Johannesburg",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(iso));

function DamagePhoto({
  evidenceFileId,
  damageItemId,
  label,
}: {
  evidenceFileId: string;
  damageItemId: string;
  label: string;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="flex flex-col gap-2">
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt={label}
          className="max-h-80 rounded object-contain"
        />
      ) : (
        <Button
          type="button"
          variant="outline"
          className="w-fit"
          disabled={pending}
          onClick={() =>
            start(async () => {
              setError(null);
              try {
                const r = await openDamagePhotoAction({
                  evidenceFileId,
                  damageItemId,
                });
                if (r.ok) setUrl(r.url);
                else setError(r.message);
              } catch {
                setError("No connection. Try again.");
              }
            })
          }
        >
          {pending ? "Opening…" : `Show ${label.toLowerCase()}`}
        </Button>
      )}
      {error ? <Alert variant="destructive">{error}</Alert> : null}
    </div>
  );
}

type Action = null | "verify" | "dispute" | "repair";

function ItemActions({
  item,
  canReview,
  canRepair,
}: {
  item: DamageRegisterItem;
  canReview: boolean;
  canRepair: boolean;
}) {
  const router = useRouter();
  const [action, setAction] = useState<Action>(null);
  const [text, setText] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  const [submissionId, setSubmissionId] = useState(() => crypto.randomUUID());
  const [busy, run] = useTransition();
  // never on your own report (DEC-24): hidden here AND refused by the database
  const canVerify =
    canReview && item.status === "reported" && !item.reportedByMe;
  const canMark = canRepair && item.status === "verified" && !item.reportedByMe;
  if (!canVerify && !canMark && !message) return null;

  function go(e: React.FormEvent) {
    e.preventDefault();
    setMessage(null);
    run(async () => {
      try {
        const r =
          action === "repair"
            ? await markDamageRepairedAction({
                itemId: item.id,
                note: text,
                clientSubmissionId: submissionId,
              })
            : await reviewDamageAction({
                itemId: item.id,
                decision: action === "dispute" ? "disputed" : "verified",
                reason: text,
                clientSubmissionId: submissionId,
              });
        setMessage({ ok: r.ok, text: r.message });
        if (r.ok) {
          setSubmissionId(crypto.randomUUID());
          setAction(null);
          router.refresh();
        }
      } catch {
        setMessage({
          ok: false,
          text: "No connection. Check your signal and submit again: it will not be applied twice.",
        });
      }
    });
  }

  return (
    <div className="flex flex-col gap-2">
      {!action ? (
        <div className="flex flex-wrap gap-2">
          {canVerify ? (
            <>
              <Button
                type="button"
                onClick={() => {
                  setText("");
                  setAction("verify");
                }}
              >
                Verify
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setText("");
                  setAction("dispute");
                }}
              >
                Dispute
              </Button>
            </>
          ) : null}
          {canMark ? (
            <Button
              type="button"
              onClick={() => {
                setText("");
                setAction("repair");
              }}
            >
              Mark repaired
            </Button>
          ) : null}
        </div>
      ) : (
        <form
          onSubmit={go}
          className="flex max-w-lg flex-col gap-2"
          aria-label="Damage decision"
        >
          <Label htmlFor={`d-${item.id}`}>
            {action === "dispute"
              ? "Reason for disputing (required)"
              : action === "repair"
                ? "Repair note (required)"
                : "Note (optional)"}
          </Label>
          <Textarea
            id={`d-${item.id}`}
            value={text}
            maxLength={500}
            required={action !== "verify"}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="flex gap-2">
            <Button
              type="submit"
              disabled={busy || (action !== "verify" && text.trim() === "")}
            >
              {busy
                ? "Saving…"
                : action === "dispute"
                  ? "Dispute"
                  : action === "repair"
                    ? "Mark repaired"
                    : "Verify"}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => setAction(null)}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
      {message ? (
        <Alert variant={message.ok ? "success" : "destructive"} role="status">
          {message.text}
        </Alert>
      ) : null}
    </div>
  );
}

/**
 * A vehicle's damage register (DEC-42): open items first, then the history. Verify / Dispute need allocation.manage for the branch,
 * Mark repaired needs service.record.create, and nobody sees those buttons on their own report (the database refuses it too).
 * Photos open one at a time through the logged signed-URL path. No names are shown (DEC-37/41).
 */
export function DamageRegister({
  items,
  canReview,
  canRepair,
}: {
  items: DamageRegisterItem[];
  canReview: boolean;
  canRepair: boolean;
}) {
  const open = items.filter(
    (i) => i.status === "reported" || i.status === "verified",
  );
  const closed = items.filter(
    (i) => i.status === "disputed" || i.status === "repaired",
  );
  const card = (i: DamageRegisterItem) => (
    <li
      key={i.id}
      className="flex flex-col gap-2 rounded-lg border p-4"
      data-testid="damage-item"
    >
      <p className="flex flex-wrap items-center gap-2 font-medium">
        {i.zoneLabel}
        <Badge variant="outline">{severityLabel(i.severity)}</Badge>
        <Badge
          variant={
            i.status === "reported"
              ? "warning"
              : i.status === "verified"
                ? "success"
                : "outline"
          }
          data-testid="damage-status"
        >
          {damageStatusLabel(i.status)}
        </Badge>
        {i.source === "onboarding" ? (
          <Badge variant="outline">Existing damage</Badge>
        ) : null}
        {i.reportedByMe ? (
          <Badge variant="outline">Reported by you</Badge>
        ) : null}
      </p>
      <p>{i.description}</p>
      <p className="text-muted-foreground text-xs">
        Reported {when(i.reportedAt)}
      </p>
      <ul
        className="text-muted-foreground flex flex-col gap-1 text-xs"
        aria-label="Status history"
      >
        <li>Reported {when(i.reportedAt)}</li>
        {i.reviewedAt ? (
          <li>
            {i.status === "disputed" ? "Disputed" : "Verified"}{" "}
            {when(i.reviewedAt)}
            {i.reviewReason ? ` — ${i.reviewReason}` : ""}
          </li>
        ) : null}
        {i.repairedAt ? (
          <li>
            Repaired {when(i.repairedAt)}
            {i.repairNote ? ` — ${i.repairNote}` : ""}
          </li>
        ) : null}
      </ul>
      {i.photoIds.map((f, n) => (
        <DamagePhoto
          key={f}
          evidenceFileId={f}
          damageItemId={i.id}
          label={`Photo ${n + 1}`}
        />
      ))}
      <ItemActions item={i} canReview={canReview} canRepair={canRepair} />
    </li>
  );
  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3" aria-label="Open damage">
        <h2 className="text-lg font-semibold">Open damage ({open.length})</h2>
        {open.length === 0 ? (
          <Alert>No open damage is recorded for this vehicle.</Alert>
        ) : (
          <ul className="flex flex-col gap-3">{open.map(card)}</ul>
        )}
      </section>
      {closed.length > 0 ? (
        <section className="flex flex-col gap-3" aria-label="Closed damage">
          <h2 className="text-lg font-semibold">Closed ({closed.length})</h2>
          <ul className="flex flex-col gap-3">{closed.map(card)}</ul>
        </section>
      ) : null}
    </div>
  );
}

/** "Record existing damage" (day-one load, DEC-42): allocation.manage only; photos from the in-app camera. */
export function RecordExistingDamage({
  vehicleId,
  noticeAcknowledged,
}: {
  vehicleId: string;
  noticeAcknowledged: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [noticeOk, setNoticeOk] = useState(noticeAcknowledged);
  const [done, setDone] = useState(false);
  return (
    <div className="flex flex-col gap-3">
      {done ? (
        <Alert variant="success" role="status">
          Existing damage recorded. It is listed below and still needs to be
          verified by a different manager.
        </Alert>
      ) : null}
      {open ? (
        <DamageReporter
          vehicleId={vehicleId}
          noticeAcknowledged={noticeOk}
          onNoticeAcknowledged={() => setNoticeOk(true)}
          submitLabel="Record this damage"
          onCancel={() => setOpen(false)}
          onReported={() => {
            setOpen(false);
            setDone(true);
            router.refresh();
          }}
        />
      ) : (
        <Button
          type="button"
          variant="outline"
          className="w-fit"
          onClick={() => {
            setDone(false);
            setOpen(true);
          }}
        >
          Record existing damage
        </Button>
      )}
    </div>
  );
}
