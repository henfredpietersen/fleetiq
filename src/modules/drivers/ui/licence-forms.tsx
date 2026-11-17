"use client";

import { useActionState, useState, useTransition } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  getEvidenceReadUrlAction,
  registerEvidenceUploadAction,
  requestEvidenceUploadAction,
} from "@/modules/evidence-storage/server/actions";
import {
  idle,
  type ActionState,
} from "@/modules/identity-access/ui/action-state";
import { Field, FormMessage } from "@/modules/identity-access/ui/form-parts";
import { recordLicenceAction, verifyLicenceAction } from "../server/actions";

type UploadResult =
  { ok: true; evidenceFileId: string } | { ok: false; message: string };

/**
 * Reuses the 1C evidence flow end to end: server issues a slot at a server-chosen private path -> the browser PUTs
 * the file to the signed upload URL -> the server verifies, strips metadata and registers it. Nothing here chooses
 * a path or holds an elevated key. A retry reuses the same client submission id (idempotent).
 */
async function uploadLicencePhoto(
  file: File,
  branchId: string,
  submissionId: string,
): Promise<UploadResult> {
  const slotResult = await requestEvidenceUploadAction({
    purpose: "licence",
    branchId,
    captureSource: "file_upload",
    mimeType: file.type,
    sizeBytes: file.size,
    clientSubmissionId: submissionId,
  });
  if (!slotResult.ok) return { ok: false, message: slotResult.message };
  const { slot } = slotResult;
  if (slot.alreadyRegistered && slot.evidenceFileId)
    return { ok: true, evidenceFileId: slot.evidenceFileId };
  if (!slot.alreadyUploaded) {
    if (!slot.uploadUrl)
      return { ok: false, message: "Could not prepare the upload. Try again." };
    const body = new FormData();
    body.append("cacheControl", "3600");
    body.append("", file);
    const put = await fetch(slot.uploadUrl, { method: "PUT", body });
    if (!put.ok)
      return {
        ok: false,
        message:
          "The photo could not be uploaded. Check your connection and try again.",
      };
  }
  const reg = await registerEvidenceUploadAction({ slotId: slot.slotId });
  if (!reg.ok) return { ok: false, message: reg.message };
  return { ok: true, evidenceFileId: reg.evidence.evidenceFileId };
}

export function LicenceForm({
  driverId,
  branchId,
}: {
  driverId: string;
  branchId: string;
}) {
  const [state, setState] = useState<ActionState>(idle);
  const [pending, startTransition] = useTransition();
  const [prdp, setPrdp] = useState(false);
  // one id per form instance: used for both the upload slot and the licence record, so a retry is idempotent
  const [submissionId, setSubmissionId] = useState(() => crypto.randomUUID());

  function submit(form: HTMLFormElement) {
    const data = new FormData(form);
    const file = data.get("photo");
    data.delete("photo");
    startTransition(async () => {
      setState(idle);
      if (file instanceof File && file.size > 0) {
        const up = await uploadLicencePhoto(file, branchId, submissionId);
        if (!up.ok) return setState({ status: "error", message: up.message });
        data.set("evidenceFileId", up.evidenceFileId);
      }
      data.set("clientSubmissionId", submissionId);
      const result = await recordLicenceAction(idle, data);
      setState(result);
      if (result.status === "success") {
        form.reset();
        setPrdp(false);
        setSubmissionId(crypto.randomUUID());
      }
    });
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit(e.currentTarget);
      }}
      className="flex max-w-xl flex-col gap-4"
      noValidate
    >
      <input type="hidden" name="driverId" value={driverId} />
      <Field
        id="licenceNumber"
        label="Licence number"
        maxLength={50}
        autoComplete="off"
        required
      />
      <Field
        id="licenceCode"
        label="Licence code"
        hint="For example EB or C1."
        maxLength={20}
        required
      />
      <div className="grid grid-cols-2 gap-4">
        <Field id="issueDate" label="Issue date" type="date" required />
        <Field id="expiryDate" label="Expiry date" type="date" required />
      </div>
      <div className="flex items-center gap-2">
        <input
          id="prdpRequired"
          name="prdpRequired"
          type="checkbox"
          className="size-4"
          checked={prdp}
          onChange={(e) => setPrdp(e.target.checked)}
        />
        <Label htmlFor="prdpRequired">
          A professional driving permit (PrDP) is required
        </Label>
      </div>
      {prdp ? (
        <Field
          id="prdpExpiryDate"
          label="PrDP expiry date"
          type="date"
          required
        />
      ) : null}
      <Field
        id="photo"
        label="Photo of the licence (optional)"
        type="file"
        accept="image/jpeg,image/png"
        hint="JPEG or PNG. Stored privately; only people allowed to see licence details can open it."
      />
      <FormMessage state={state} />
      <div>
        <Button type="submit" size="lg" disabled={pending} aria-busy={pending}>
          {pending ? "Saving…" : "Record licence"}
        </Button>
      </div>
    </form>
  );
}

export function VerifyLicenceForm({
  licenceId,
  driverId,
}: {
  licenceId: string;
  driverId: string;
}) {
  const [state, action, pending] = useActionState(verifyLicenceAction, idle);
  return (
    <form action={action} className="flex flex-col gap-3" noValidate>
      <input type="hidden" name="licenceId" value={licenceId} />
      <input type="hidden" name="driverId" value={driverId} />
      <div className="flex flex-col gap-2">
        <Label htmlFor={`reason-${licenceId}`}>
          Reason (required to reject)
        </Label>
        <Textarea
          id={`reason-${licenceId}`}
          name="reason"
          rows={2}
          maxLength={500}
        />
      </div>
      <div className="flex gap-3">
        <Button
          type="submit"
          name="decision"
          value="verified"
          disabled={pending}
        >
          Verify
        </Button>
        <Button
          type="submit"
          name="decision"
          value="rejected"
          variant="outline"
          disabled={pending}
        >
          Reject
        </Button>
      </div>
      <FormMessage state={state} />
    </form>
  );
}

/** Opens the licence photo through the logged, short-lived signed URL (ARCH §6.6). */
export function ViewEvidenceButton({
  evidenceFileId,
  licenceId,
}: {
  evidenceFileId: string;
  licenceId: string;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-1">
      <Button
        type="button"
        variant="outline"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setError(null);
            const r = await getEvidenceReadUrlAction({
              evidenceFileId,
              purpose: "licence review",
              relatedEntityType: "driver_licence",
              relatedEntityId: licenceId,
            });
            if (!r.ok) return setError("The photo is not available to you.");
            window.open(r.url, "_blank", "noopener,noreferrer");
          })
        }
      >
        {pending ? "Opening…" : "View photo"}
      </Button>
      {error ? <Alert variant="destructive">{error}</Alert> : null}
    </div>
  );
}
