"use client";
// The in-app camera (AD-07, DEC-04, DEC-07): rear camera, full-screen preview, an in-app shutter, then "Use photo" / "Retake".
// The frame is drawn to a canvas and encoded as JPEG (numbers in CAMERA_CAPTURE). There is NO file input, NO `capture`
// attribute, NO gallery and NO drag-and-drop anywhere here — and the server refuses anything that is not an in-app capture.
// The shutter time is the phone's clock (untrusted). Location: ONE request when the camera opens, with a short timeout; refused,
// slow or unavailable = null and capture carries on (DEC-29). The stream is released when this screen closes.
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { encodeJpeg, type CanvasLike } from "../domain/camera-image";
import { CAMERA_NOTICE } from "../domain/camera-notice";
import { CAMERA_CAPTURE } from "../domain/evidence-config";
import { parseLocation, type CaptureLocation } from "../domain/validate";
import { acknowledgeCameraNoticeAction } from "../server/notice-actions";

export type CameraResult = {
  blob: Blob;
  width: number;
  height: number;
  capturedAt: string;
  location: CaptureLocation | null;
  capturedOffline: boolean;
};

export const CAMERA_NEEDED_TEXT =
  "This inspection needs the phone camera, and it cannot be used right now. Allow camera access for this site in your phone's settings and try again, or call your supervisor.";

type Phase = "notice" | "starting" | "live" | "review" | "blocked";

export function CameraCapture({
  title,
  noticeAcknowledged,
  onNoticeAcknowledged,
  onUse,
  onClose,
}: {
  title: string;
  noticeAcknowledged: boolean;
  onNoticeAcknowledged: () => void;
  onUse: (photo: CameraResult) => void;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<Phase>(
    noticeAcknowledged ? "starting" : "notice",
  );
  const [error, setError] = useState<string | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const locationFix = useRef<Promise<CaptureLocation | null>>(
    Promise.resolve(null),
  );
  const [shot, setShot] = useState<{
    result: CameraResult;
    url: string;
  } | null>(null);

  const release = useCallback(() => {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
  }, []);

  // start the camera (and ask for the location once) when we get past the notice; release both on close
  useEffect(() => {
    if (phase !== "starting") return;
    let cancelled = false;
    // ONE location request when the camera opens; refused, slow or unavailable = null and capture carries on (DEC-29)
    locationFix.current = new Promise<CaptureLocation | null>((resolve) => {
      if (!navigator.geolocation) return resolve(null);
      navigator.geolocation.getCurrentPosition(
        (p) =>
          resolve(
            parseLocation({
              latitude: p.coords.latitude,
              longitude: p.coords.longitude,
              accuracyM: p.coords.accuracy,
            }),
          ),
        () => resolve(null),
        {
          timeout: CAMERA_CAPTURE.locationTimeoutMs,
          maximumAge: CAMERA_CAPTURE.locationMaxAgeMs,
          enableHighAccuracy: false,
        },
      );
    });
    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia)
          throw new Error("no camera API");
        const s = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
          audio: false,
        });
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream.current = s;
        if (video.current) {
          video.current.srcObject = s;
          await video.current.play().catch(() => undefined);
        }
        setPhase("live");
      } catch {
        if (!cancelled) setPhase("blocked");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [phase]);

  useEffect(() => release, [release]);
  useEffect(() => () => void (shot && URL.revokeObjectURL(shot.url)), [shot]);

  async function acknowledge() {
    try {
      await acknowledgeCameraNoticeAction();
      onNoticeAcknowledged();
    } catch {
      /* the notice never blocks the camera */
    }
    setPhase("starting");
  }

  async function takePhoto() {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    const capturedAt = new Date().toISOString(); // the shutter moment, phone clock, untrusted
    setError(null);
    try {
      // a fix still on its way gets a moment more, never longer: the photo is not held up for it
      const location = await Promise.race([
        locationFix.current,
        new Promise<null>((r) => setTimeout(() => r(null), 1500)),
      ]);
      const enc = await encodeJpeg(
        v,
        { width: v.videoWidth, height: v.videoHeight },
        () => document.createElement("canvas") as unknown as CanvasLike,
      );
      setShot({
        url: URL.createObjectURL(enc.blob),
        result: {
          ...enc,
          capturedAt,
          location,
          capturedOffline:
            typeof navigator !== "undefined" && !navigator.onLine,
        },
      });
      setPhase("review");
    } catch {
      setError("The photo could not be taken. Try again.");
    }
  }

  function retake() {
    setShot(null);
    setPhase("live");
  }

  function close() {
    release();
    onClose();
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      data-testid="camera"
      className="fixed inset-0 z-50 flex flex-col bg-black text-white"
    >
      <div className="flex items-center justify-between p-3">
        <p className="font-medium">{title}</p>
        <Button
          type="button"
          variant="outline"
          className="min-h-12 text-black"
          onClick={close}
        >
          Close
        </Button>
      </div>

      {phase === "notice" ? (
        <div
          className="flex flex-1 flex-col justify-center gap-4 p-5"
          data-testid="camera-notice"
        >
          <h2 className="text-xl font-semibold">{CAMERA_NOTICE.title}</h2>
          <p className="text-base">{CAMERA_NOTICE.body}</p>
          <Button
            type="button"
            size="lg"
            className="min-h-14 w-full text-base"
            onClick={acknowledge}
          >
            {CAMERA_NOTICE.understand}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="lg"
            className="min-h-14 w-full text-base text-black"
            onClick={() => setPhase("starting")}
          >
            {CAMERA_NOTICE.later}
          </Button>
        </div>
      ) : null}

      {phase === "blocked" ? (
        <div
          className="flex flex-1 flex-col justify-center gap-4 p-5"
          data-testid="camera-unavailable"
          role="alert"
        >
          <p className="text-lg">{CAMERA_NEEDED_TEXT}</p>
          <Button
            type="button"
            size="lg"
            className="min-h-14 w-full text-base"
            onClick={() => setPhase("starting")}
          >
            Try again
          </Button>
        </div>
      ) : null}

      {/* the preview stays mounted while reviewing (hidden), so Retake keeps the live stream */}
      {phase === "starting" || phase === "live" || phase === "review" ? (
        <div
          className={
            phase === "review" ? "hidden" : "relative flex flex-1 flex-col"
          }
        >
          <video
            ref={video}
            playsInline
            muted
            autoPlay
            className="min-h-0 w-full flex-1 object-cover"
            data-testid="camera-preview"
          />
          {phase === "starting" ? (
            <p className="absolute inset-x-0 top-1/2 text-center">
              Starting the camera…
            </p>
          ) : null}
          <div className="flex flex-col items-center gap-2 p-4">
            {error ? <p role="alert">{error}</p> : null}
            <button
              type="button"
              aria-label="Take photo"
              disabled={phase !== "live"}
              onClick={takePhoto}
              className="size-20 rounded-full border-4 border-white bg-white/90 disabled:opacity-40"
            />
          </div>
        </div>
      ) : null}

      {phase === "review" && shot ? (
        <div className="flex flex-1 flex-col">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={shot.url}
            alt="The photo you just took"
            className="min-h-0 w-full flex-1 object-contain"
            data-testid="camera-review"
          />
          <div className="flex flex-col gap-2 p-4">
            <Button
              type="button"
              size="lg"
              className="min-h-14 w-full text-base"
              onClick={() => onUse(shot.result)}
            >
              Use photo
            </Button>
            <Button
              type="button"
              variant="outline"
              size="lg"
              className="min-h-14 w-full text-base text-black"
              onClick={retake}
            >
              Retake
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
