"use client";

import { useEffect, useRef, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  CameraCapture,
  type CameraResult,
} from "@/modules/evidence-storage/ui/camera-capture";
import { getDeviceKey } from "@/modules/evidence-storage/ui/device-key";
import { registerEvidenceUploadAction } from "@/modules/evidence-storage/server/actions";
import {
  recordOnboardingDamageAction,
  reportDamageAction,
  requestDamageSlotAction,
} from "../server/damage-actions";
import {
  DAMAGE_SEVERITIES,
  DAMAGE_ZONES,
  DAMAGE_ZONE_LABELS,
  DESCRIPTION_MAX,
  MAX_DAMAGE_PHOTOS,
  SEVERITY_LABELS,
} from "../domain/damage-zones";
import {
  newPendingDamagePhoto,
  sendDamagePhoto,
  type DamagePhotoApi,
  type PendingDamagePhoto,
} from "./damage-photo-upload";

const noConnection =
  "No connection. Check your signal and tap again: it will not be done twice.";

const api: DamagePhotoApi = {
  requestSlot: (i) => requestDamageSlotAction(i),
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
};

type PhotoRow = {
  key: string;
  pending: PendingDamagePhoto;
  status: "sending" | "failed" | "done";
  message?: string;
};

/**
 * Report one damage item: where (plain-words zone), how serious, a description, and at least one photo from the IN-APP camera (there is
 * no file picker: DEC-04/41). In an inspection it calls report_damage(); for the day-one load it calls record_onboarding_damage().
 * Photos upload as they are taken (retryable, idempotent); the report itself carries one client_submission_id reused on every retry.
 * Nothing here says or implies who is at fault.
 */
export function DamageReporter({
  inspectionId,
  vehicleId,
  noticeAcknowledged,
  onNoticeAcknowledged,
  onReported,
  onCancel,
  submitLabel = "Report this damage",
}: {
  inspectionId?: string;
  vehicleId?: string;
  noticeAcknowledged: boolean;
  onNoticeAcknowledged: () => void;
  onReported: () => void;
  onCancel?: () => void;
  submitLabel?: string;
}) {
  const [zone, setZone] = useState("");
  const [severity, setSeverity] = useState("");
  const [description, setDescription] = useState("");
  const [photos, setPhotos] = useState<PhotoRow[]>([]);
  const [camera, setCamera] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const deviceKey = useRef<string | null>(null);
  const submissionId = useRef(crypto.randomUUID());
  useEffect(() => {
    void getDeviceKey().then((k) => (deviceKey.current = k));
  }, []);

  const ready = photos.filter((p) => p.status === "done");
  const valid =
    !!zone &&
    !!severity &&
    description.trim().length > 0 &&
    description.length <= DESCRIPTION_MAX &&
    ready.length > 0 &&
    !photos.some((p) => p.status === "sending");

  async function send(row: PhotoRow) {
    setPhotos((s) =>
      s.map((p) =>
        p.key === row.key ? { ...p, status: "sending", message: undefined } : p,
      ),
    );
    const r = await sendDamagePhoto(
      row.pending,
      { inspectionId, vehicleId, deviceKey: deviceKey.current },
      api,
    );
    setPhotos((s) =>
      s.map((p) =>
        p.key === row.key
          ? r.ok
            ? { ...p, status: "done" }
            : {
                ...p,
                status: "failed",
                message: r.retry ? "Not sent — Retry" : r.message,
              }
          : p,
      ),
    );
  }
  function onUse(c: CameraResult) {
    setCamera(false);
    const row: PhotoRow = {
      key: crypto.randomUUID(),
      pending: newPendingDamagePhoto(c),
      status: "sending",
    };
    setPhotos((s) => [...s, row]);
    void send(row);
  }

  async function submit() {
    setMessage(null);
    setBusy(true);
    try {
      const body = {
        zone,
        severity,
        description,
        evidenceFileIds: ready.map((p) => p.pending.evidenceFileId!),
        clientSubmissionId: submissionId.current,
      };
      const r = inspectionId
        ? await reportDamageAction({
            ...body,
            inspectionId,
            deviceReportedAt: new Date().toISOString(),
            capturedOffline:
              typeof navigator !== "undefined" && !navigator.onLine,
          })
        : await recordOnboardingDamageAction({ ...body, vehicleId });
      if (r.ok) {
        submissionId.current = crypto.randomUUID();
        setZone("");
        setSeverity("");
        setDescription("");
        setPhotos([]);
        onReported();
      } else setMessage(r.message);
    } catch {
      setMessage(noConnection);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className="flex flex-col gap-4 rounded-lg border p-4"
      aria-label="Report new damage"
      data-testid="damage-reporter"
    >
      <div className="flex flex-col gap-2">
        <Label htmlFor="damage-zone">Where on the vehicle?</Label>
        <Select
          id="damage-zone"
          value={zone}
          onChange={(e) => setZone(e.target.value)}
        >
          <option value="">Choose a part of the vehicle</option>
          {DAMAGE_ZONES.map((z) => (
            <option key={z} value={z}>
              {DAMAGE_ZONE_LABELS[z]}
            </option>
          ))}
        </Select>
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium" id="damage-severity-label">
          How serious is it?
        </span>
        <div
          role="radiogroup"
          aria-labelledby="damage-severity-label"
          className="flex flex-wrap gap-2"
        >
          {DAMAGE_SEVERITIES.map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={severity === s}
              onClick={() => setSeverity(s)}
              className={
                "min-h-12 min-w-20 rounded-md border px-4 text-base font-medium " +
                (severity === s
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-background")
              }
            >
              {SEVERITY_LABELS[s]}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="damage-description">What does it look like?</Label>
        <Textarea
          id="damage-description"
          value={description}
          maxLength={DESCRIPTION_MAX}
          placeholder="Describe the damage"
          onChange={(e) => setDescription(e.target.value)}
        />
        <p className="text-muted-foreground text-xs">
          {description.length} / {DESCRIPTION_MAX}
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <p className="text-sm font-medium">
          Photos ({ready.length} attached) — at least one, taken with the camera
        </p>
        <ul className="flex flex-col gap-2">
          {photos.map((p, n) => (
            <li
              key={p.key}
              className="flex flex-wrap items-center gap-2 text-sm"
            >
              <span>Photo {n + 1}</span>
              {p.status === "sending" ? (
                <span role="status">Sending…</span>
              ) : null}
              {p.status === "done" ? (
                <Badge variant="success">Attached</Badge>
              ) : null}
              {p.status === "failed" ? (
                <>
                  <span role="alert" className="text-destructive">
                    {p.message}
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-10"
                    onClick={() => void send(p)}
                  >
                    Retry
                  </Button>
                </>
              ) : null}
            </li>
          ))}
        </ul>
        <Button
          type="button"
          size="lg"
          variant={ready.length > 0 ? "outline" : "default"}
          className="min-h-14 w-full text-base"
          disabled={busy || photos.length >= MAX_DAMAGE_PHOTOS}
          onClick={() => setCamera(true)}
        >
          {photos.length === 0
            ? "Take a photo of the damage"
            : "Add another photo"}
        </Button>
      </div>
      {message ? (
        <Alert variant="destructive" role="alert">
          {message}
        </Alert>
      ) : null}
      <Button
        type="button"
        size="lg"
        className="min-h-14 w-full text-base"
        disabled={busy || !valid}
        onClick={() => void submit()}
      >
        {busy ? "Saving…" : submitLabel}
      </Button>
      {onCancel ? (
        <Button
          type="button"
          variant="outline"
          size="lg"
          className="min-h-12 w-full"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </Button>
      ) : null}
      {camera ? (
        <CameraCapture
          title="Damage photo"
          noticeAcknowledged={noticeAcknowledged}
          onNoticeAcknowledged={onNoticeAcknowledged}
          onUse={onUse}
          onClose={() => setCamera(false)}
        />
      ) : null}
    </section>
  );
}
