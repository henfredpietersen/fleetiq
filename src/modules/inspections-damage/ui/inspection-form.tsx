"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  CameraCapture,
  type CameraResult,
} from "@/modules/evidence-storage/ui/camera-capture";
import { getDeviceKey } from "@/modules/evidence-storage/ui/device-key";
import { registerEvidenceUploadAction } from "@/modules/evidence-storage/server/actions";
import {
  beginInspectionAction,
  saveAnswersAction,
  submitInspectionAction,
} from "../server/inspection-actions";
import {
  attachDefectPhotoAction,
  attachOdometerPhotoAction,
  requestPhotoSlotAction,
} from "../server/photo-actions";
import { submitBlockers, type Blocker } from "../domain/inspection-readiness";
import {
  needsComment,
  responseOptions,
  stageLabel,
} from "../domain/inspection-rules";
import type { InspectionItem, MyInspection } from "../domain/inspection-types";
import {
  newPendingPhoto,
  sendPhoto,
  type PendingPhoto,
  type PhotoApi,
} from "./photo-upload";

type Answer = { value?: string; comment?: string };
type Step = "vehicle" | "checklist" | "defects" | "odometer" | "review";
type PhotoState = {
  status: "sending" | "failed" | "done";
  message?: string;
  pending?: PendingPhoto;
};
type Target = {
  key: string;
  kind: "odometer" | "defect";
  item?: InspectionItem;
};

const STEP_LABEL: Record<Step, string> = {
  vehicle: "Confirm the vehicle",
  checklist: "Checklist",
  defects: "Defect photos",
  odometer: "Odometer photo",
  review: "Review and submit",
};
const noConnection =
  "No connection. Check your signal and tap again: it will not be done twice.";

const api: PhotoApi = {
  requestSlot: (i) => requestPhotoSlotAction(i),
  put: async (url, blob) => {
    try {
      const body = new FormData();
      body.append("cacheControl", "3600");
      body.append("", blob);
      return (await fetch(url, { method: "PUT", body })).ok;
    } catch {
      return false;
    }
  },
  register: (slotId) => registerEvidenceUploadAction({ slotId }),
  attach: (i) =>
    i.kind === "odometer"
      ? attachOdometerPhotoAction({
          inspectionId: i.inspectionId,
          evidenceFileId: i.evidenceFileId,
          clientSubmissionId: i.clientSubmissionId,
        })
      : attachDefectPhotoAction({
          inspectionId: i.inspectionId,
          evidenceFileId: i.evidenceFileId,
          templateItemId: i.templateItemId,
          clientSubmissionId: i.clientSubmissionId,
        }),
};

/**
 * The driver's inspection (mobile first: one task per screen, large tap targets). Steps: confirm the vehicle -> checklist ->
 * defect photos (one per Defect item) -> odometer photo -> review -> Submit. Answers save as the driver goes
 * (save_inspection_responses is idempotent), so a reload resumes the draft from my_inspection. Every photo comes from the
 * in-app camera: there is no file picker or gallery anywhere here (DEC-04, DEC-41). Submit is enabled only when the server's own
 * rules would pass (submitBlockers mirrors them) and every refusal message from the server is shown as is (IN001–IN014).
 */
export function InspectionForm({
  allocationId,
  data,
  noticeAcknowledged,
}: {
  allocationId: string;
  data: MyInspection;
  noticeAcknowledged: boolean;
}) {
  const router = useRouter();
  const insp = data.inspection;
  const draft = insp?.status === "draft";
  const v = data.vehicle;
  const [busy, setBusy] = useState(false);
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
  const [step, setStep] = useState<Step>(
    insp?.vehicle_confirmed ? "checklist" : "vehicle",
  );
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  const [saveState, setSaveState] = useState<"saved" | "saving" | "failed">(
    "saved",
  );
  const [photos, setPhotos] = useState<Record<string, PhotoState>>({});
  const [camera, setCamera] = useState<Target | null>(null);
  const [noticeOk, setNoticeOk] = useState(noticeAcknowledged);
  const [done, setDone] = useState<{ late: boolean; safety: boolean } | null>(
    null,
  );
  const deviceKey = useRef<string | null>(null);
  useEffect(() => {
    void getDeviceKey().then((k) => (deviceKey.current = k));
  }, []);

  // one id per distinct save payload / user action, reused on every retry (DEC-06)
  const ids = useRef<Record<string, string>>({});
  const idFor = (k: string) => (ids.current[k] ??= crypto.randomUUID());
  const forget = (k: string) => delete ids.current[k];
  const offline = () => typeof navigator !== "undefined" && !navigator.onLine;

  const payload = useMemo(
    () =>
      data.items.flatMap((i) => {
        const a = answers[i.template_item_id];
        return a?.value
          ? [
              {
                templateItemId: i.template_item_id,
                value: a.value,
                comment: a.comment?.trim() ? a.comment : undefined,
              },
            ]
          : [];
      }),
    [answers, data.items],
  );
  const payloadKey = JSON.stringify([payload, confirmed]);
  const lastSaved = useRef(
    JSON.stringify([
      data.items.flatMap((i) =>
        i.answer
          ? [
              {
                templateItemId: i.template_item_id,
                value: i.answer.value,
                comment: i.answer.comment?.trim()
                  ? i.answer.comment
                  : undefined,
              },
            ]
          : [],
      ),
      insp?.vehicle_confirmed ?? false,
    ]),
  );

  const persist = useCallback(async (): Promise<boolean> => {
    if (!insp || !draft) return true;
    if (payloadKey === lastSaved.current) return true;
    setSaveState("saving");
    try {
      const r = await saveAnswersAction({
        inspectionId: insp.id,
        responses: payload,
        vehicleConfirmed: confirmed,
        clientSubmissionId: idFor("save:" + payloadKey),
      });
      if (r.ok) {
        lastSaved.current = payloadKey;
        setSaveState("saved");
        return true;
      }
      setSaveState("failed");
      setMessage({ ok: false, text: r.message });
      return false;
    } catch {
      setSaveState("failed");
      setMessage({ ok: false, text: noConnection });
      return false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [insp, draft, payloadKey, payload, confirmed]);

  // save as the driver goes
  useEffect(() => {
    if (!draft || payloadKey === lastSaved.current) return;
    const t = setTimeout(() => void persist(), 700);
    return () => clearTimeout(t);
  }, [draft, payloadKey, persist]);

  const defects = data.items.filter(
    (i) =>
      i.response_type === "ok_defect" &&
      answers[i.template_item_id]?.value === "defect",
  );
  const filledItem = (id: string) =>
    photos[`item:${id}`]?.status === "done" ||
    data.photo_slots.some(
      (s) => s.kind === "defect_photo" && s.template_item_id === id && s.filled,
    );
  const odometerDone =
    data.odometer_photo_present || photos.odo?.status === "done";
  const blockers: Blocker[] = submitBlockers({
    vehicleConfirmed: confirmed,
    registration: v.registration,
    items: data.items.map((i) => ({
      id: i.template_item_id,
      question: i.question,
      responseType: i.response_type,
      required: i.required,
      sequence: i.sequence,
    })),
    answers,
    itemsWithPhoto: new Set(
      defects
        .filter((d) => filledItem(d.template_item_id))
        .map((d) => d.template_item_id),
    ),
    odometerPhoto: odometerDone,
  });
  const steps: Step[] = [
    "vehicle",
    "checklist",
    ...(defects.length > 0 ? (["defects"] as Step[]) : []),
    "odometer",
    "review",
  ];
  const at = steps.indexOf(step) < 0 ? 0 : steps.indexOf(step);

  async function go(to: Step) {
    setMessage(null);
    if (!(await persist())) return;
    setStep(to);
  }
  async function next() {
    await go(steps[Math.min(at + 1, steps.length - 1)]!);
  }

  async function begin() {
    setMessage(null);
    setBusy(true);
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
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    if (!insp) return;
    setMessage(null);
    setBusy(true);
    try {
      if (!(await persist())) return;
      const r = await submitInspectionAction({
        inspectionId: insp.id,
        deviceSubmittedAt: new Date().toISOString(),
        capturedOffline: offline(),
        clientSubmissionId: idFor("submit"),
      });
      if (r.ok) {
        forget("submit");
        setDone({ late: !!r.lateFlag, safety: !!r.safetyDefectFlag });
        router.refresh();
      } else setMessage({ ok: false, text: r.message });
    } catch {
      setMessage({ ok: false, text: noConnection });
    } finally {
      setBusy(false);
    }
  }

  async function send(t: Target, pending: PendingPhoto) {
    if (!insp) return;
    setPhotos((p) => ({ ...p, [t.key]: { status: "sending", pending } }));
    const r = await sendPhoto(
      pending,
      { inspectionId: insp.id, deviceKey: deviceKey.current },
      api,
    );
    if (r.ok) {
      setPhotos((p) => ({ ...p, [t.key]: { status: "done" } }));
      router.refresh();
    } else {
      setPhotos((p) => ({
        ...p,
        [t.key]: {
          status: "failed",
          message: r.retry ? "Not sent — Retry" : r.message,
          pending: r.retry ? pending : undefined,
        },
      }));
    }
  }
  function onUse(t: Target, c: CameraResult) {
    setCamera(null);
    void send(
      t,
      newPendingPhoto(
        c,
        t.kind === "odometer"
          ? { kind: "odometer" }
          : { kind: "defect", templateItemId: t.item!.template_item_id },
      ),
    );
  }

  const photoButton = (t: Target, label: string, retakeLabel: string) => {
    const st = photos[t.key];
    const filled =
      t.kind === "odometer"
        ? odometerDone
        : filledItem(t.item!.template_item_id);
    return (
      <div className="flex flex-col gap-2">
        {st?.status === "sending" ? (
          <p role="status">Sending the photo…</p>
        ) : null}
        {st?.status === "failed" ? (
          <Alert variant="destructive" role="alert">
            {st.message}
          </Alert>
        ) : null}
        {filled ? (
          <Badge variant="success" className="w-fit">
            Attached
          </Badge>
        ) : null}
        {st?.status === "failed" && st.pending ? (
          <Button
            type="button"
            size="lg"
            className="min-h-14 w-full text-base"
            onClick={() => void send(t, st.pending!)}
          >
            Retry
          </Button>
        ) : null}
        <Button
          type="button"
          size="lg"
          variant={filled ? "outline" : "default"}
          className="min-h-14 w-full text-base"
          disabled={st?.status === "sending" || busy}
          onClick={() => setCamera(t)}
        >
          {filled || st?.status === "failed" ? retakeLabel : label}
        </Button>
      </div>
    );
  };

  const header = (
    <div>
      <p className="text-lg font-semibold">
        {v.fleet_number} · {v.registration}
      </p>
      <p className="text-muted-foreground text-sm">
        {v.make} {v.model} · {stageLabel(data.stage)} inspection
      </p>
    </div>
  );
  const back = (
    <Link
      href="/my-allocations"
      className={buttonVariants({
        variant: "outline",
        size: "lg",
        className: "min-h-14 w-full text-base",
      })}
    >
      Back to my allocations
    </Link>
  );

  // ---- finished (just now, or when the page is opened later)
  if (done || insp?.status === "submitted") {
    const late = done ? done.late : insp!.late_flag;
    const safety = done ? done.safety : insp!.safety_defect_flag;
    return (
      <div className="flex flex-col gap-4" data-testid="inspection-submitted">
        {header}
        <Alert variant="success" role="status">
          {data.stage === "pre_shift"
            ? "Inspection submitted — the vehicle is now in use."
            : "Post-shift inspection submitted."}
        </Alert>
        {late ? (
          <Alert
            role="status"
            data-testid="late-notice"
            className="border-amber-600/40 text-amber-800"
          >
            Submitted late.
          </Alert>
        ) : null}
        {safety ? (
          <Alert
            variant="destructive"
            role="status"
            data-testid="safety-notice"
          >
            Safety defect reported — your supervisor has been told.
          </Alert>
        ) : null}
        {insp?.captured_offline ? (
          <Badge variant="outline" className="w-fit">
            Captured offline
          </Badge>
        ) : null}
        {data.stage === "post_shift" ? (
          <p className="text-muted-foreground text-sm">
            Your shift is over. The allocation now waits for closure by your
            supervisor.
          </p>
        ) : null}
        {back}
      </div>
    );
  }

  if (insp?.status === "void") {
    return (
      <div className="flex flex-col gap-4">
        {header}
        <Alert>
          This inspection was voided by your supervisor. Ask them what to do
          next.
        </Alert>
        {back}
      </div>
    );
  }

  // ---- post-shift confirmation (C2): beginning ends the driver's use of the vehicle
  if (
    !insp &&
    data.stage === "post_shift" &&
    data.allocation_status === "in_use"
  ) {
    return (
      <div className="flex flex-col gap-3" data-testid="end-shift-confirm">
        {header}
        <Alert className="border-amber-600/40 text-amber-800">
          Start the post-shift inspection? This ends your use of{" "}
          {v.fleet_number} / {v.registration}. You cannot go back to driving it
          on this allocation.
        </Alert>
        {message ? (
          <Alert variant="destructive" role="alert">
            {message.text}
          </Alert>
        ) : null}
        <Button
          type="button"
          size="lg"
          className="min-h-14 w-full text-base"
          disabled={busy}
          onClick={begin}
        >
          {busy ? "Starting…" : "Start post-shift inspection"}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="lg"
          className="min-h-14 w-full text-base"
          disabled={busy}
          onClick={() => router.push("/my-allocations")}
        >
          Cancel
        </Button>
      </div>
    );
  }

  if (!insp) {
    return (
      <div className="flex flex-col gap-4" data-testid="inspection-start">
        {header}
        <Alert>
          This is the {stageLabel(data.stage).toLowerCase()} checklist for this
          vehicle ({data.items.length} items). You will need the phone camera
          for the odometer photo.
        </Alert>
        {message ? (
          <Alert variant="destructive" role="alert">
            {message.text}
          </Alert>
        ) : null}
        <Button
          type="button"
          size="lg"
          className="min-h-14 w-full text-base"
          disabled={busy}
          onClick={begin}
        >
          {busy ? "Starting…" : "Start inspection"}
        </Button>
      </div>
    );
  }

  // ---- the draft, one task per screen
  return (
    <div className="flex flex-col gap-5" data-testid="inspection-form">
      {header}
      <div
        className="flex items-center justify-between text-sm"
        data-testid="progress"
      >
        <span className="font-medium">
          Step {at + 1} of {steps.length}: {STEP_LABEL[step]}
        </span>
        <span className="text-muted-foreground" aria-live="polite">
          {saveState === "saving"
            ? "Saving…"
            : saveState === "failed"
              ? "Not saved"
              : "Saved"}
        </span>
      </div>

      {step === "vehicle" ? (
        <div className="flex flex-col gap-4">
          <div className="rounded-lg border p-4">
            <p className="text-xl font-semibold">{v.fleet_number}</p>
            <p className="text-lg">{v.registration}</p>
            <p className="text-muted-foreground">
              {v.make} {v.model}
            </p>
          </div>
          <Button
            type="button"
            size="lg"
            className="min-h-14 w-full text-base"
            disabled={busy}
            onClick={async () => {
              setConfirmed(true);
              // persist right away: the next screen depends on it
              setBusy(true);
              try {
                const r = await saveAnswersAction({
                  inspectionId: insp.id,
                  responses: payload,
                  vehicleConfirmed: true,
                  clientSubmissionId: idFor("confirm"),
                });
                if (r.ok) {
                  lastSaved.current = JSON.stringify([payload, true]);
                  setStep("checklist");
                } else {
                  setConfirmed(false);
                  setMessage({ ok: false, text: r.message });
                }
              } catch {
                setConfirmed(false);
                setMessage({ ok: false, text: noConnection });
              } finally {
                setBusy(false);
              }
            }}
          >
            This is the vehicle I am inspecting
          </Button>
        </div>
      ) : null}

      {step === "checklist" ? (
        <div className="flex flex-col gap-4">
          <ol className="flex flex-col gap-4" aria-label="Checklist">
            {data.items.map((item, n) => {
              const a = answers[item.template_item_id] ?? {};
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
                    {responseOptions(item.response_type, item.allow_na).map(
                      (o) => (
                        <button
                          key={o.value}
                          type="button"
                          role="radio"
                          aria-checked={a.value === o.value}
                          onClick={() => {
                            setMessage(null);
                            setAnswers((s) => ({
                              ...s,
                              [item.template_item_id]: {
                                ...s[item.template_item_id],
                                value: o.value,
                              },
                            }));
                          }}
                          className={
                            "min-h-12 min-w-16 rounded-md border px-4 text-base font-medium " +
                            (a.value === o.value
                              ? "bg-primary text-primary-foreground border-primary"
                              : "bg-background")
                          }
                        >
                          {o.label}
                        </button>
                      ),
                    )}
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
                      maxLength={1000}
                      onChange={(e) =>
                        setAnswers((s) => ({
                          ...s,
                          [item.template_item_id]: {
                            ...s[item.template_item_id],
                            comment: e.target.value,
                          },
                        }))
                      }
                    />
                  ) : null}
                </li>
              );
            })}
          </ol>
          <Button
            type="button"
            size="lg"
            className="min-h-14 w-full text-base"
            disabled={busy}
            onClick={next}
          >
            Next
          </Button>
        </div>
      ) : null}

      {step === "defects" ? (
        <div className="flex flex-col gap-4" data-testid="defect-photos">
          <p className="text-sm">
            Take at least one photo of each defect you reported.
          </p>
          {defects.map((item) => {
            const a = answers[item.template_item_id];
            return (
              <section
                key={item.template_item_id}
                className="flex flex-col gap-2 rounded-lg border p-3"
                data-testid="defect-photo-slot"
              >
                <p className="font-medium">{item.question}</p>
                {a?.comment?.trim() ? (
                  <p className="text-muted-foreground text-sm">{a.comment}</p>
                ) : (
                  <Alert variant="destructive">
                    A comment is needed. Go back to the checklist and describe
                    the defect.
                  </Alert>
                )}
                {photoButton(
                  {
                    key: `item:${item.template_item_id}`,
                    kind: "defect",
                    item,
                  },
                  "Take photo of the defect",
                  "Take another photo",
                )}
              </section>
            );
          })}
          <Button
            type="button"
            size="lg"
            className="min-h-14 w-full text-base"
            disabled={busy}
            onClick={next}
          >
            Next
          </Button>
        </div>
      ) : null}

      {step === "odometer" ? (
        <div className="flex flex-col gap-4" data-testid="odometer-step">
          <p>
            Take a clear photo of the odometer. The reading must be easy to
            read.
          </p>
          {photoButton(
            { key: "odo", kind: "odometer" },
            "Take odometer photo",
            "Retake odometer photo",
          )}
          <Button
            type="button"
            size="lg"
            className="min-h-14 w-full text-base"
            disabled={busy}
            onClick={next}
          >
            Next
          </Button>
        </div>
      ) : null}

      {step === "review" ? (
        <div className="flex flex-col gap-4" data-testid="review-step">
          {blockers.length === 0 ? (
            <Alert variant="success" role="status">
              Everything is in place. You can submit.
            </Alert>
          ) : (
            <div className="flex flex-col gap-2" data-testid="submit-blocked">
              <p className="font-medium">Still to do ({blockers.length}):</p>
              <ul className="flex flex-col gap-2">
                {blockers.map((b) => (
                  <li key={b.code} className="rounded-lg border p-3 text-sm">
                    <p>{b.message}</p>
                    <Button
                      type="button"
                      variant="outline"
                      className="mt-2 min-h-12"
                      onClick={() =>
                        setStep(
                          b.code === "IN001"
                            ? "vehicle"
                            : b.code === "IN006"
                              ? "odometer"
                              : b.code === "IN004"
                                ? "defects"
                                : "checklist",
                        )
                      }
                    >
                      Fix this
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <Button
            type="button"
            size="lg"
            className="min-h-14 w-full text-base"
            disabled={busy || blockers.length > 0}
            onClick={submit}
          >
            {busy ? "Submitting…" : "Submit inspection"}
          </Button>
        </div>
      ) : null}

      {step !== "vehicle" ? (
        <Button
          type="button"
          variant="outline"
          size="lg"
          className="min-h-12 w-full"
          disabled={busy}
          onClick={() => void go(steps[Math.max(at - 1, 0)]!)}
        >
          Back
        </Button>
      ) : null}

      {message ? (
        <Alert variant={message.ok ? "success" : "destructive"} role="status">
          {message.text}
        </Alert>
      ) : null}

      {camera ? (
        <CameraCapture
          title={
            camera.kind === "odometer"
              ? "Odometer photo"
              : `Defect photo: ${camera.item?.question ?? ""}`
          }
          noticeAcknowledged={noticeOk}
          onNoticeAcknowledged={() => setNoticeOk(true)}
          onUse={(c) => onUse(camera, c)}
          onClose={() => setCamera(null)}
        />
      ) : null}
    </div>
  );
}
