"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { openReadingPhotoAction } from "../server/review-actions";

/**
 * The odometer photo of one reading. It is requested through the signed-URL path as soon as the card is shown: each opening is a
 * logged, short-lived URL request (ARCH §6.6) and the database checks can_view_evidence. A failure is shown with a retry, never silently.
 */
export function ReadingPhoto({
  evidenceFileId,
  readingId,
  label,
}: {
  evidenceFileId: string | null;
  readingId: string;
  label: string;
}) {
  const [state, setState] = useState<
    | { s: "loading" }
    | { s: "ready"; url: string }
    | { s: "error"; message: string }
  >({
    s: evidenceFileId ? "loading" : "error",
    ...(evidenceFileId
      ? {}
      : { message: "There is no photo for this reading." }),
  } as never);
  const load = useCallback(async () => {
    if (!evidenceFileId) return;
    setState({ s: "loading" });
    try {
      const r = await openReadingPhotoAction({ evidenceFileId, readingId });
      setState(
        r.ok ? { s: "ready", url: r.url } : { s: "error", message: r.message },
      );
    } catch {
      setState({
        s: "error",
        message:
          "The photo could not be loaded. Check your connection and try again.",
      });
    }
  }, [evidenceFileId, readingId]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one logged request when the card appears
    void load();
  }, [load]);
  if (state.s === "ready")
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={state.url}
        alt={label}
        data-testid="reading-photo"
        className="max-h-80 w-full rounded border object-contain"
        onError={() =>
          setState({
            s: "error",
            message: "The photo could not be shown. It may have expired.",
          })
        }
      />
    );
  if (state.s === "loading")
    return (
      <p
        role="status"
        className="text-muted-foreground flex h-40 items-center justify-center rounded border text-sm"
      >
        Loading the photo…
      </p>
    );
  return (
    <div className="flex flex-col gap-2">
      <Alert variant="destructive" role="alert">
        {state.message}
      </Alert>
      {evidenceFileId ? (
        <Button
          type="button"
          variant="outline"
          className="w-fit"
          onClick={() => void load()}
        >
          Try the photo again
        </Button>
      ) : null}
    </div>
  );
}
