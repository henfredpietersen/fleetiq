"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  beginInspectionAction,
  saveAnswersAction,
  submitInspectionAction,
} from "../server/inspection-actions";
import {
  CAMERA_LATER_TEXT,
  needsComment,
  responseOptions,
  stageLabel,
} from "../domain/inspection-rules";
import type { InspectionItem, MyInspection } from "../domain/inspection-types";

type Answer = { value?: string; comment?: string };

/**
 * The driver's inspection form, rendered from the template (answers only: the camera arrives in 4B, nothing is faked).
 * Every action carries a client_submission_id that is created once per user action and reused on every retry, so a dropped
 * connection followed by a second tap cannot save or submit twice (DEC-06). The database decides what is allowed and its
 * refusal message is shown as is. Submit stays disabled until a current odometer photo exists.
 */
export function InspectionForm({
  allocationId,
  data,
}: {
  allocationId: string;
  data: MyInspection;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const insp = data.inspection;
  const draft = insp?.status === "draft";
  const [answers, setAnswers] = useState<Record<string, Answer>>(() =>
    Object.fromEntries(
      data.items.map((i) => [
        i.template_item_id,
        i.answer
          ? { value: i.answer.value, comment: i.answer.comment ?? "" }
          : {},
      ]),
    ),
  );
  const [confirmed, setConfirmed] = useState(insp?.vehicle_confirmed ?? false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  // one id per user action; cleared when its outcome is known or the input changes
  const ids = useRef<Record<string, string | null>>({});
  const idFor = (k: string) => (ids.current[k] ??= crypto.randomUUID());
  const forget = (...ks: string[]) =>
    ks.forEach((k) => (ids.current[k] = null));
  const offline = () => typeof navigator !== "undefined" && !navigator.onLine;

  function set(item: InspectionItem, patch: Answer) {
    forget("save", "submit");
    setAnswers((a) => ({
      ...a,
      [item.template_item_id]: { ...a[item.template_item_id], ...patch },
    }));
  }

  function payload() {
    return data.items.flatMap((i) => {
      const a = answers[i.template_item_id];
      return a?.value
        ? [
            {
              templateItemId: i.template_item_id,
              value: a.value,
              comment: a.comment?.trim() ? a.comment : undefined,
              deviceAnsweredAt: new Date().toISOString(),
            },
          ]
        : [];
    });
  }

  const noConnection =
    "No connection. Check your signal and tap again: it will not be done twice.";

  function begin() {
    setMessage(null);
    start(async () => {
      try {
        const r = await beginInspectionAction({
          allocationId,
          stage: data.stage,
          deviceStartedAt: new Date().toISOString(),
          capturedOffline: offline(),
          clientSubmissionId: idFor("begin"),
        });
        if (r.ok) {
          forget("begin");
          router.refresh();
        } else setMessage({ ok: false, text: r.message });
      } catch {
        setMessage({ ok: false, text: noConnection });
      }
    });
  }

  async function save(): Promise<boolean> {
    if (!insp) return false;
    const r = await saveAnswersAction({
      inspectionId: insp.id,
      responses: payload(),
      vehicleConfirmed: confirmed,
      clientSubmissionId: idFor("save"),
    });
    if (r.ok) forget("save");
    else setMessage({ ok: false, text: r.message });
    return r.ok;
  }

  function saveOnly() {
    setMessage(null);
    start(async () => {
      try {
        if (await save()) setMessage({ ok: true, text: "Answers saved." });
      } catch {
        setMessage({ ok: false, text: noConnection });
      }
    });
  }

  function submit() {
    if (!insp) return;
    setMessage(null);
    start(async () => {
      try {
        if (!(await save())) return;
        const r = await submitInspectionAction({
          inspectionId: insp.id,
          deviceSubmittedAt: new Date().toISOString(),
          capturedOffline: offline(),
          clientSubmissionId: idFor("submit"),
        });
        if (r.ok) {
          forget("submit");
          router.refresh();
        } else setMessage({ ok: false, text: r.message });
      } catch {
        setMessage({ ok: false, text: noConnection });
      }
    });
  }

  const v = data.vehicle;
  const canSubmit = draft && data.odometer_photo_present && !pending;

  return (
    <div className="flex flex-col gap-5" data-testid="inspection-form">
      <div>
        <p className="text-lg font-semibold">
          {v.fleet_number} · {v.registration}
        </p>
        <p className="text-muted-foreground text-sm">
          {v.make} {v.model} · {stageLabel(data.stage)} inspection
        </p>
      </div>

      {insp?.status === "submitted" ? (
        <div className="flex flex-col gap-2" data-testid="inspection-submitted">
          <Alert variant="success">Inspection submitted. Thank you.</Alert>
          <div className="flex flex-wrap gap-2">
            {insp.late_flag ? <Badge variant="warning">Late</Badge> : null}
            {insp.safety_defect_flag ? (
              <Badge variant="destructive">Safety defect</Badge>
            ) : null}
            {insp.captured_offline ? (
              <Badge variant="outline">Captured offline</Badge>
            ) : null}
          </div>
        </div>
      ) : null}

      {!insp ? (
        <>
          <Alert>
            This is the {stageLabel(data.stage).toLowerCase()} checklist for
            this vehicle ({data.items.length} items). Start the inspection to
            answer it.
          </Alert>
          <Button
            type="button"
            size="lg"
            className="min-h-14 w-full text-base"
            disabled={pending}
            onClick={begin}
          >
            {pending ? "Starting…" : "Start inspection"}
          </Button>
        </>
      ) : (
        <>
          <ol className="flex flex-col gap-4" aria-label="Checklist">
            {data.items.map((item, n) => {
              const a = answers[item.template_item_id] ?? {};
              const opts = responseOptions(item.response_type, item.allow_na);
              return (
                <li
                  key={item.template_item_id}
                  className="flex flex-col gap-2 rounded-lg border p-3"
                  data-testid="inspection-item"
                >
                  <p className="font-medium">
                    {n + 1}. {item.question}{" "}
                    {item.severity_rule === "safety_critical" ? (
                      <Badge variant="outline">Safety</Badge>
                    ) : null}
                  </p>
                  <div
                    role="radiogroup"
                    aria-label={item.question}
                    className="flex flex-wrap gap-2"
                  >
                    {opts.map((o) => (
                      <button
                        key={o.value}
                        type="button"
                        role="radio"
                        aria-checked={a.value === o.value}
                        disabled={!draft || pending}
                        onClick={() => set(item, { value: o.value })}
                        className={
                          "min-h-12 min-w-16 rounded-md border px-4 text-base font-medium " +
                          (a.value === o.value
                            ? "bg-primary text-primary-foreground border-primary"
                            : "bg-background")
                        }
                      >
                        {o.label}
                      </button>
                    ))}
                  </div>
                  {needsComment(item.response_type, a.value) ? (
                    <Textarea
                      aria-label={`Comment: ${item.question}`}
                      placeholder={
                        a.value === "defect"
                          ? "Describe the defect"
                          : "Add the details"
                      }
                      value={a.comment ?? ""}
                      disabled={!draft || pending}
                      maxLength={1000}
                      onChange={(e) => set(item, { comment: e.target.value })}
                    />
                  ) : null}
                </li>
              );
            })}
          </ol>

          <section
            aria-label="Photos"
            className="flex flex-col gap-2 rounded-lg border border-dashed p-3 text-sm"
            data-testid="photo-slots"
          >
            <p className="font-medium">Photos</p>
            {data.photo_slots.map((s) => (
              <p key={`${s.kind}-${s.template_item_id ?? "odo"}`}>
                {s.kind === "odometer"
                  ? "Odometer photo (required)"
                  : `Photo of the defect: ${s.question ?? ""}`}
                :{" "}
                {s.filled ? (
                  <Badge variant="success">Attached</Badge>
                ) : (
                  <span className="text-muted-foreground">
                    {CAMERA_LATER_TEXT}
                  </span>
                )}
              </p>
            ))}
          </section>

          {draft ? (
            <>
              <label className="flex items-start gap-3 text-base">
                <input
                  type="checkbox"
                  className="mt-1 size-6"
                  checked={confirmed}
                  disabled={pending}
                  onChange={(e) => {
                    forget("save", "submit");
                    setConfirmed(e.target.checked);
                  }}
                />
                <span>
                  I confirm this is vehicle {v.fleet_number} ({v.registration}).
                </span>
              </label>
              {!data.odometer_photo_present ? (
                <p
                  className="text-muted-foreground text-sm"
                  data-testid="submit-blocked"
                >
                  Submit stays disabled until the odometer photo is attached.
                </p>
              ) : null}
              <div className="flex flex-col gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="lg"
                  className="min-h-14 w-full text-base"
                  disabled={pending}
                  onClick={saveOnly}
                >
                  {pending ? "Saving…" : "Save answers"}
                </Button>
                <Button
                  type="button"
                  size="lg"
                  className="min-h-14 w-full text-base"
                  disabled={!canSubmit}
                  onClick={submit}
                >
                  Submit inspection
                </Button>
              </div>
            </>
          ) : null}
        </>
      )}
      {message ? (
        <Alert variant={message.ok ? "success" : "destructive"} role="status">
          {message.text}
        </Alert>
      ) : null}
    </div>
  );
}
