"use client";

import { useState, useTransition } from "react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  openInspectionPhotoAction,
  showPhotoLocationAction,
  type PhotoLocation,
} from "../server/review-actions";

/**
 * One inspection photo for a reviewer. Nothing is fetched until "Show photo" is pressed (each opening is a logged signed-URL
 * request). "Show photo location" exists only for people who can review exceptions in the branch; the database re-checks and
 * logs every call, and the person who took the photo is always refused (DEC-29).
 */
export function EvidencePhoto({
  evidenceFileId,
  inspectionId,
  label,
  current,
  canSeeLocation,
}: {
  evidenceFileId: string;
  inspectionId: string;
  label: string;
  /** false = an earlier photo replaced by a retake */
  current?: boolean;
  canSeeLocation: boolean;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loc, setLoc] = useState<PhotoLocation | null>(null);
  const [pending, start] = useTransition();
  return (
    <div
      className="flex flex-col gap-2 rounded-lg border p-3"
      data-testid="evidence-photo"
    >
      <p className="flex flex-wrap items-center gap-2 font-medium">
        {label}
        {current === false ? (
          <Badge variant="outline">Not current (retaken)</Badge>
        ) : null}
      </p>
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt={label}
          className="max-h-96 w-full rounded object-contain"
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
                const r = await openInspectionPhotoAction({
                  evidenceFileId,
                  inspectionId,
                });
                if (r.ok) setUrl(r.url);
                else setError(r.message);
              } catch {
                setError("No connection. Try again.");
              }
            })
          }
        >
          {pending ? "Opening…" : "Show photo"}
        </Button>
      )}
      {error ? <Alert variant="destructive">{error}</Alert> : null}
      {canSeeLocation ? (
        loc?.ok ? (
          <p className="text-sm" data-testid="photo-location">
            {loc.none
              ? "No location was recorded for this photo."
              : `Location: ${loc.latitude}, ${loc.longitude}${loc.accuracyM != null ? ` (about ${loc.accuracyM} m)` : ""}`}
          </p>
        ) : (
          <>
            <Button
              type="button"
              variant="outline"
              className="w-fit"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  try {
                    setLoc(await showPhotoLocationAction({ evidenceFileId }));
                  } catch {
                    setLoc({ ok: false, message: "No connection. Try again." });
                  }
                })
              }
            >
              Show photo location
            </Button>
            {loc && !loc.ok ? (
              <Alert variant="destructive">{loc.message}</Alert>
            ) : null}
          </>
        )
      ) : null}
    </div>
  );
}
