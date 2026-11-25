"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  CameraCapture,
  type CameraResult,
} from "@/modules/evidence-storage/ui/camera-capture";
import { DamageReporter } from "./damage-report";
import { damageStatusLabel, severityLabel } from "../domain/damage-zones";
import { submitBlockers, type Blocker } from "../domain/inspection-readiness";
import {
  needsComment,
  responseOptions,
  stageLabel,
} from "../domain/inspection-rules";
import type { InspectionItem, MyInspection } from "../domain/inspection-types";
import {
  applyQueue,
  isLocalInspectionId,
  type Overlay,
} from "../offline/domain/overlay";
import {
  digitsOnly,
  parseReading,
  READING_MAX_DIGITS,
} from "@/modules/odometer-mileage/domain/reading-input";
import { scopeOf, type ItemPayload } from "../offline/domain/types";
import { ScopeStatusLine } from "../offline/ui/sync-bar";
import { useSync, type SyncManager } from "../offline/ui/sync-manager";

type Answer = { value?: string; comment?: string };
type Step =
  "vehicle" | "damage" | "checklist" | "defects" | "odometer" | "review";
type Target = {
  key: string;
  kind: "odometer" | "defect";
  item?: InspectionItem;
};

const STEP_LABEL: Record<Step, string> = {
  vehicle: "Confirm the vehicle",
  damage: "Known damage on this vehicle",
  checklist: "Checklist",
  defects: "Defect photos",
  odometer: "Odometer photo",
  review: "Review and submit",
};
const notSaved =
  "This could not be saved on the phone. Check the phone's storage and try again.";

/**
 * The driver's inspection (mobile first: one task per screen, large tap targets). Steps: confirm the vehicle -> known damage ->
 * checklist -> defect photos (one per Defect item) -> odometer photo -> review -> Submit.
 *
 * EVERY write goes through the phone's queue (DEC-06, ARCH §6.9), online or offline: the action is saved on the phone first with
 * its own client_submission_id, then sent in order, retried with the same id and cleared only after the server confirms. The form
 * shows the server's data with the queued items applied on top (applyQueue), so it works with no connection from the snapshot.
 * Every photo comes from the in-app camera: there is no file picker or gallery anywhere here (DEC-04, DEC-41). Submit is enabled
 * only when the server's own rules would pass (submitBlockers mirrors them); the server's refusals are shown as they are.
 */
export function InspectionForm({
  allocationId,
  data,
  noticeAcknowledged,
  mode = "driver",
  profileId,
  onSynced,
}: {
  allocationId: string;
  /** The server's data (the live page, or the snapshot taken while online). */
  data: MyInspection;
  noticeAcknowledged: boolean;
  /** "on_behalf" (DEC-09): a supervisor completing the post-shift inspection for the driver, with a permanent banner. */
  mode?: "driver" | "on_behalf";
  profileId: string;
  /** Called when the server has confirmed something that changes what the page shows (default: re-read the page). */
  onSynced?: () => void;
}) {
  const { state, manager } = useSync(profileId);
  const scope = scopeOf(allocationId, data.stage);
  const ov = useMemo(
    () => applyQueue(data, state.items, scope),
    [data, state.items, scope],
  );
  if (!state.ready)
    return (
      <p role="status" className="text-muted-foreground text-sm">
        Loading your inspection…
      </p>
    );
  return (
    <FormBody
      key={scope}
      allocationId={allocationId}
      ov={ov}
      noticeAcknowledged={noticeAcknowledged}
      mode={mode}
      profileId={profileId}
      manager={manager}
      scope={scope}
      sync={{ online: state.online }}
      onSynced={onSynced}
    />
  );
}

function FormBody({
  allocationId,
  ov,
  noticeAcknowledged,
  mode,
  profileId,
  manager,
  scope,
  sync,
  onSynced,
}: {
  allocationId: string;
  ov: Overlay;
  noticeAcknowledged: boolean;
  mode: "driver" | "on_behalf";
  profileId: string;
  manager: SyncManager;
  scope: string;
  sync: { online: boolean };
  onSynced?: () => void;
}) {
  const router = useRouter();
  const data = ov.data;
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
  const [knownReviewed, setKnownReviewed] = useState(
    insp?.known_damage_reviewed ?? false,
  );
  const [reporting, setReporting] = useState(false);
  const [step, setStep] = useState<Step>(
    !insp?.vehicle_confirmed
      ? "vehicle"
      : insp.known_damage_reviewed
        ? "checklist"
        : "damage",
  );
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  const [saveState, setSaveState] = useState<"saved" | "saving" | "failed">(
    "saved",
  );
  const [camera, setCamera] = useState<Target | null>(null);
  const [noticeOk, setNoticeOk] = useState(noticeAcknowledged);
  // what the server has confirmed since this form opened (the page data catches up after the refresh)
  const [attached, setAttached] = useState<Set<string>>(new Set());
  const [submitConfirmed, setSubmitConfirmed] = useState(false);
  // 5A (DEC-05): the driver's own typed reading, whole km, digits only; there is never an OCR value on this phone
  const [readingText, setReadingText] = useState(() =>
    data.reading?.driver_reading_km != null
      ? String(data.reading.driver_reading_km)
      : "",
  );
  const [readingError, setReadingError] = useState<string | null>(null);
  // re-read the server's data once something was confirmed; with no connection that waits (a failed page refresh would reload the page)
  const refreshDue = useRef(false);
  const refresh = useCallback(() => {
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      refreshDue.current = true;
      return;
    }
    refreshDue.current = false;
    if (onSynced) onSynced();
    else router.refresh();
  }, [onSynced, router]);
  useEffect(() => {
    if (sync.online && refreshDue.current) refresh();
  }, [sync.online, refresh]);

  useEffect(
    () =>
      manager.onItemDone((item) => {
        if (item.scope !== scope) return;
        const p = item.payload;
        if (p.kind === "photo")
          setAttached((s) =>
            new Set(s).add(
              p.target.kind === "odometer"
                ? "odo"
                : `item:${p.target.templateItemId}`,
            ),
          );
        if (p.kind === "submit") setSubmitConfirmed(true);
        if (
          p.kind === "begin" ||
          p.kind === "submit" ||
          p.kind === "report_damage"
        )
          refresh();
      }),
    [manager, scope, refresh],
  );

  const enqueue = useCallback(
    (payload: ItemPayload, blobs?: { id: string; blob: Blob }[]) =>
      manager.enqueue({
        allocationId,
        stage: data.stage,
        inspectionId:
          insp && !isLocalInspectionId(insp.id) ? insp.id : undefined,
        payload,
        blobs,
      }),
    [manager, allocationId, data.stage, insp],
  );

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

  // answers are saved on the phone as the driver goes (the queue sends them in order)
  const persist = useCallback(async (): Promise<boolean> => {
    if (!insp || !draft) return true;
    if (payloadKey === lastSaved.current) return true;
    setSaveState("saving");
    try {
      await enqueue({
        kind: "save",
        responses: payload,
        vehicleConfirmed: confirmed,
      });
      lastSaved.current = payloadKey;
      setSaveState("saved");
      return true;
    } catch {
      setSaveState("failed");
      setMessage({ ok: false, text: notSaved });
      return false;
    }
  }, [insp, draft, payloadKey, payload, confirmed, enqueue]);

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
  const defectQueued = (id: string) => ov.defectPhotosQueued.has(id);
  const defectAttached = (id: string) =>
    attached.has(`item:${id}`) ||
    data.photo_slots.some(
      (s) => s.kind === "defect_photo" && s.template_item_id === id && s.filled,
    );
  const filledItem = (id: string) => defectQueued(id) || defectAttached(id);
  const odometerAttached = data.odometer_photo_present || attached.has("odo");
  const odometerDone = odometerAttached || ov.odometerQueued;
  const blockers: Blocker[] = submitBlockers({
    vehicleConfirmed: confirmed,
    knownDamageReviewed: knownReviewed,
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
    readingEntered: data.reading?.driver_reading_km != null,
  });
  const steps: Step[] = [
    "vehicle",
    "damage",
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
      await enqueue({ kind: "begin" });
    } catch {
      setMessage({ ok: false, text: notSaved });
    } finally {
      setBusy(false);
    }
  }

  async function confirmVehicle() {
    if (!insp) return;
    setMessage(null);
    setConfirmed(true);
    setBusy(true);
    try {
      await enqueue({
        kind: "save",
        responses: payload,
        vehicleConfirmed: true,
      });
      lastSaved.current = JSON.stringify([payload, true]);
      setStep("damage");
    } catch {
      setConfirmed(false);
      setMessage({ ok: false, text: notSaved });
    } finally {
      setBusy(false);
    }
  }

  /** Saves the typed reading on the phone (the queue sends it after the photo). false = the value is not acceptable (the message is shown). */
  async function commitReading(): Promise<boolean> {
    if (!insp || !draft) return true;
    if (readingText.trim() === "") return true;
    const p = parseReading(readingText);
    if (!p.ok) {
      setReadingError(p.message);
      return false;
    }
    setReadingError(null);
    if (data.reading?.driver_reading_km === p.km) return true;
    try {
      await enqueue({ kind: "reading", km: p.km });
      return true;
    } catch {
      setMessage({ ok: false, text: notSaved });
      return false;
    }
  }

  async function submit() {
    if (!insp) return;
    setMessage(null);
    setBusy(true);
    try {
      if (!(await persist())) return;
      await enqueue({ kind: "submit" });
    } catch {
      setMessage({ ok: false, text: notSaved });
    } finally {
      setBusy(false);
    }
  }

  async function onUse(t: Target, c: CameraResult) {
    setCamera(null);
    setMessage(null);
    const blobId = crypto.randomUUID();
    try {
      await enqueue(
        {
          kind: "photo",
          target:
            t.kind === "odometer"
              ? { kind: "odometer" }
              : { kind: "defect", templateItemId: t.item!.template_item_id },
          photo: {
            blobId,
            size: c.blob.size,
            width: c.width,
            height: c.height,
            capturedAt: c.capturedAt,
            location: c.location,
            capturedOffline: c.capturedOffline,
          },
          attachCsid: crypto.randomUUID(),
        },
        [{ id: blobId, blob: c.blob }],
      );
      // a retake: the new photo is what counts until the server confirms it
      setAttached((s) => {
        const n = new Set(s);
        n.delete(t.key);
        return n;
      });
    } catch {
      setMessage({ ok: false, text: notSaved });
    }
  }

  const photoButton = (t: Target, label: string, retakeLabel: string) => {
    const queued =
      t.kind === "odometer"
        ? ov.odometerQueued
        : defectQueued(t.item!.template_item_id);
    const attachedNow =
      t.kind === "odometer"
        ? odometerAttached
        : defectAttached(t.item!.template_item_id);
    const filled = queued || attachedNow;
    return (
      <div className="flex flex-col gap-2">
        {queued ? (
          <Badge variant="outline" className="w-fit" data-testid="photo-queued">
            Saved on this phone
          </Badge>
        ) : attachedNow ? (
          <Badge variant="success" className="w-fit">
            Attached
          </Badge>
        ) : null}
        <Button
          type="button"
          size="lg"
          variant={filled ? "outline" : "default"}
          className="min-h-14 w-full text-base"
          disabled={busy}
          onClick={() => setCamera(t)}
        >
          {filled ? retakeLabel : label}
        </Button>
      </div>
    );
  };

  async function confirmKnown() {
    if (!insp) return;
    setMessage(null);
    setBusy(true);
    try {
      await enqueue({ kind: "confirm_known" });
      setKnownReviewed(true);
      setStep("checklist");
    } catch {
      setMessage({ ok: false, text: notSaved });
    } finally {
      setBusy(false);
    }
  }

  const onBehalf = insp?.completed_by_role === "supervisor_on_behalf";
  const banner = onBehalf ? (
    <Alert
      className="border-amber-600/40 text-amber-800"
      role="status"
      data-testid="on-behalf-banner"
    >
      Completing on behalf of the driver — reason: {insp?.on_behalf_reason}
    </Alert>
  ) : null;

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
  const backHref =
    mode === "on_behalf" ? "/shifts/allocations" : "/my-allocations";
  const back = (
    <Link
      href={backHref}
      className={buttonVariants({
        variant: "outline",
        size: "lg",
        className: "min-h-14 w-full text-base",
      })}
    >
      {mode === "on_behalf" ? "Back to allocations" : "Back to my allocations"}
    </Link>
  );

  // ---- finished (just now, or when the page is opened later)
  if (insp?.status === "submitted") {
    const late = insp.late_flag;
    const safety = insp.safety_defect_flag;
    return (
      <div className="flex flex-col gap-4" data-testid="inspection-submitted">
        {header}
        {banner}
        <Alert variant="success" role="status">
          {data.stage === "pre_shift"
            ? "Inspection submitted — the vehicle is now in use."
            : "Post-shift inspection submitted."}
        </Alert>
        {data.reading ? (
          <Alert role="status" data-testid="reading-status">
            Odometer reading (
            {data.reading.driver_reading_km?.toLocaleString("en-ZA")} km):{" "}
            {data.reading.status === "accepted"
              ? "Accepted"
              : data.reading.status === "needs_supervisor"
                ? "Needs a supervisor"
                : "Reading sent for checking"}
          </Alert>
        ) : null}
        {data.stage === "pre_shift" && data.new_damage.length > 0 ? (
          <Alert role="status" data-testid="new-damage-notice">
            New damage recorded — your supervisor will review it.
          </Alert>
        ) : null}
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
            {mode === "on_behalf"
              ? "The driver's shift is over. The allocation now waits for closure."
              : "Your shift is over. The allocation now waits for closure by your supervisor."}
          </p>
        ) : null}
        {back}
      </div>
    );
  }

  // ---- sent to the phone's queue: the server has not confirmed it yet (or the answer is on its way)
  if (insp && draft && (ov.submitQueued || submitConfirmed)) {
    return (
      <div className="flex flex-col gap-4" data-testid="inspection-queued">
        {header}
        {banner}
        <Alert role="status" data-testid="queued-notice">
          {submitConfirmed
            ? "Submitted. Updating…"
            : sync.online
              ? "Saved on this phone — sending now."
              : "Saved on this phone — it will be sent as soon as you have a connection. You can close the app."}
        </Alert>
        <ScopeStatusLine profileId={profileId} scope={scope} />
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

  // ---- a supervisor is completing this inspection on the driver's behalf: read-only for everyone else (the database refuses their writes)
  if (onBehalf && !insp?.viewer_is_completer) {
    return (
      <div className="flex flex-col gap-4" data-testid="on-behalf-readonly">
        {header}
        {banner}
        <Alert>
          Your supervisor is completing this post-shift inspection for you.
          There is nothing more for you to do.
        </Alert>
        {back}
      </div>
    );
  }

  // ---- the draft, one task per screen
  return (
    <div className="flex flex-col gap-5" data-testid="inspection-form">
      {header}
      {banner}
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
              : ov.waiting > 0
                ? "Saved on this phone"
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
            onClick={() => void confirmVehicle()}
          >
            This is the vehicle I am inspecting
          </Button>
        </div>
      ) : null}

      {step === "damage" ? (
        <div className="flex flex-col gap-4" data-testid="damage-step">
          <p className="text-sm">
            This is the damage already recorded for this vehicle. Check it
            against the vehicle before you go on.
          </p>
          {data.known_damage.length === 0 && ov.damageQueued.length === 0 ? (
            <p className="rounded-lg border p-3" data-testid="no-known-damage">
              No damage recorded yet
            </p>
          ) : null}
          {data.known_damage.length > 0 || ov.damageQueued.length > 0 ? (
            <ul className="flex flex-col gap-2" aria-label="Known damage">
              {ov.damageQueued.map((d) => (
                <li
                  key={d.id}
                  className="flex flex-col gap-1 rounded-lg border p-3"
                  data-testid="pending-damage-item"
                >
                  <p className="flex flex-wrap items-center gap-2 font-medium">
                    {d.zoneLabel}
                    <Badge variant="outline">{severityLabel(d.severity)}</Badge>
                    <Badge variant="warning">Reported now</Badge>
                    <Badge variant="outline">Saved on this phone</Badge>
                  </p>
                  <p className="text-sm">{d.description}</p>
                </li>
              ))}
              {data.known_damage.map((d) => (
                <li
                  key={d.id}
                  className="flex flex-col gap-1 rounded-lg border p-3"
                  data-testid="known-damage-item"
                >
                  <p className="flex flex-wrap items-center gap-2 font-medium">
                    {d.zone_label}
                    <Badge variant="outline">{severityLabel(d.severity)}</Badge>
                    {d.reported_now ? (
                      <Badge variant="warning">Reported now</Badge>
                    ) : (
                      <Badge variant="outline">
                        {damageStatusLabel(d.status)}
                      </Badge>
                    )}
                  </p>
                  <p className="text-sm">{d.description}</p>
                  <p className="text-muted-foreground text-xs">
                    Recorded {d.reported_at.slice(0, 10)}
                  </p>
                </li>
              ))}
            </ul>
          ) : null}
          {reporting ? (
            <DamageReporter
              queue={{
                enqueue: (payload, blobs) =>
                  enqueue(payload, blobs).then(() => undefined),
              }}
              noticeAcknowledged={noticeOk}
              onNoticeAcknowledged={() => setNoticeOk(true)}
              onCancel={() => setReporting(false)}
              onReported={() => {
                setReporting(false);
                setMessage({
                  ok: true,
                  text: "Damage reported. It is in the list above.",
                });
              }}
            />
          ) : (
            <Button
              type="button"
              size="lg"
              variant="outline"
              className="min-h-14 w-full text-base"
              disabled={busy}
              onClick={() => setReporting(true)}
            >
              Report new damage
            </Button>
          )}
          {!reporting ? (
            <Button
              type="button"
              size="lg"
              className="min-h-14 w-full text-base"
              disabled={busy}
              onClick={() =>
                knownReviewed ? setStep("checklist") : void confirmKnown()
              }
            >
              {knownReviewed ? "Next" : "I have checked this list"}
            </Button>
          ) : null}
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
          <div className="flex flex-col gap-2" data-testid="reading-field">
            <Label htmlFor="odometer-reading" className="text-base">
              Odometer reading (km)
            </Label>
            <Input
              id="odometer-reading"
              name="odometer_reading"
              inputMode="numeric"
              pattern="[0-9]*"
              autoComplete="off"
              maxLength={READING_MAX_DIGITS}
              className="h-16 text-center text-3xl font-semibold tracking-wider"
              placeholder="e.g. 123456"
              value={readingText}
              disabled={busy || !odometerDone || !draft}
              aria-invalid={readingError ? true : undefined}
              aria-describedby="odometer-reading-help"
              onChange={(e) => {
                setReadingText(digitsOnly(e.target.value));
                setReadingError(null);
              }}
              onBlur={() => void commitReading()}
            />
            <p
              id="odometer-reading-help"
              className="text-muted-foreground text-sm"
            >
              {odometerDone
                ? "Type the number you can read on the odometer in your photo, in whole kilometres."
                : "Take the odometer photo first, then type the reading shown in it."}
            </p>
            {readingError ? (
              <Alert variant="destructive" role="alert">
                {readingError}
              </Alert>
            ) : null}
          </div>
          <Button
            type="button"
            size="lg"
            className="min-h-14 w-full text-base"
            disabled={busy}
            onClick={async () => {
              if (!(await commitReading())) return;
              await next();
            }}
          >
            Next
          </Button>
        </div>
      ) : null}

      {step === "review" ? (
        <div className="flex flex-col gap-4" data-testid="review-step">
          <section
            className="flex flex-col gap-1 rounded-lg border p-3"
            data-testid="review-reading"
          >
            <p className="text-muted-foreground text-sm">
              Odometer reading you typed
            </p>
            <p className="text-2xl font-semibold">
              {data.reading?.driver_reading_km != null
                ? `${data.reading.driver_reading_km.toLocaleString("en-ZA")} km`
                : "Not entered yet"}
            </p>
            <Button
              type="button"
              variant="outline"
              className="mt-1 min-h-12 w-fit"
              onClick={() => setStep("odometer")}
            >
              Change the reading
            </Button>
          </section>
          {data.new_damage.length + ov.damageQueued.length > 0 ? (
            <section
              className="flex flex-col gap-2 rounded-lg border p-3"
              data-testid="review-new-damage"
            >
              <p className="font-medium">
                New damage reported in this inspection (
                {data.new_damage.length + ov.damageQueued.length})
              </p>
              <ul className="flex flex-col gap-1 text-sm">
                {data.new_damage.map((d) => (
                  <li key={d.id}>
                    {d.zone_label} · {severityLabel(d.severity)} —{" "}
                    {d.description}
                  </li>
                ))}
                {ov.damageQueued.map((d) => (
                  <li key={d.id}>
                    {d.zoneLabel} · {severityLabel(d.severity)} —{" "}
                    {d.description} (saved on this phone)
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
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
                            : b.code === "IN007"
                              ? "damage"
                              : b.code === "IN006" || b.code === "IN015"
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
            {busy ? "Saving…" : "Submit inspection"}
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
          onUse={(c) => void onUse(camera, c)}
          onClose={() => setCamera(null)}
        />
      ) : null}
    </div>
  );
}
