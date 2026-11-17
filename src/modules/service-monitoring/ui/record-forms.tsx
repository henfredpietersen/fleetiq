"use client";

import { useActionState, useState, useTransition } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  idle,
  type ActionState,
} from "@/modules/fleet-vehicles/domain/action-state";
import {
  Field,
  FormMessage,
  SelectField,
  SubmitButton,
} from "@/modules/fleet-vehicles/ui/form-parts";
import { getEvidenceReadUrlAction } from "@/modules/evidence-storage/server/actions";
import { uploadEvidencePhoto } from "@/modules/evidence-storage/ui/upload-evidence";
import {
  createRecordAction,
  reverseVerificationAction,
  verifyRecordAction,
} from "../server/actions";

export type RecordVehicleChoice = {
  id: string;
  label: string;
  branchId: string;
};

/**
 * Service record capture with evidence (reuses the 1C evidence flow). One submission id per form instance is used for
 * both the photo slot and the record, so a retry is idempotent. The record starts `recorded`; someone else verifies it.
 */
export function RecordServiceForm({
  vehicles,
}: {
  vehicles: RecordVehicleChoice[];
}) {
  const [state, setState] = useState<ActionState>(idle);
  const [pending, startTransition] = useTransition();
  const [submissionId, setSubmissionId] = useState(() => crypto.randomUUID());
  const [vehicleId, setVehicleId] = useState("");

  function submit(form: HTMLFormElement) {
    const data = new FormData(form);
    const file = data.get("photo");
    data.delete("photo");
    startTransition(async () => {
      setState(idle);
      const branchId = vehicles.find((v) => v.id === vehicleId)?.branchId;
      if (file instanceof File && file.size > 0) {
        if (!branchId)
          return setState({
            status: "error",
            message: "Choose the vehicle first.",
          });
        const up = await uploadEvidencePhoto({
          file,
          purpose: "service_record",
          branchId,
          submissionId,
        });
        if (!up.ok) return setState({ status: "error", message: up.message });
        data.set("evidenceFileId", up.evidenceFileId);
      }
      data.set("clientSubmissionId", submissionId);
      const result = await createRecordAction(idle, data);
      setState(result);
      if (result.status === "success") {
        form.reset();
        setVehicleId("");
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
      className="flex max-w-2xl flex-col gap-4"
      noValidate
    >
      <SelectField
        id="vehicleId"
        label="Vehicle"
        required
        value={vehicleId}
        onChange={(e) => setVehicleId(e.target.value)}
        disabled={pending}
      >
        <option value="" disabled>
          Choose a vehicle…
        </option>
        {vehicles.map((v) => (
          <option key={v.id} value={v.id}>
            {v.label}
          </option>
        ))}
      </SelectField>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          id="serviceDate"
          label="Service date"
          type="date"
          required
          disabled={pending}
        />
        <Field
          id="odometerKm"
          label="Odometer at service (km)"
          type="number"
          min={0}
          step={1}
          inputMode="numeric"
          required
          disabled={pending}
          hint="Whole km, exactly as on the invoice or job card."
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          id="serviceType"
          label="Service type"
          maxLength={100}
          required
          disabled={pending}
        />
        <SelectField
          id="source"
          label="Source"
          defaultValue="workshop"
          disabled={pending}
        >
          <option value="workshop">Workshop</option>
          <option value="manual">Manual entry</option>
        </SelectField>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field
          id="supplierName"
          label="Workshop / supplier"
          maxLength={200}
          disabled={pending}
        />
        <Field
          id="jobReference"
          label="Job card reference"
          maxLength={100}
          disabled={pending}
        />
        <Field
          id="invoiceReference"
          label="Invoice reference"
          maxLength={100}
          disabled={pending}
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field
          id="labourCost"
          label="Labour cost (optional)"
          type="number"
          min={0}
          step="0.01"
          disabled={pending}
        />
        <Field
          id="partsCost"
          label="Parts cost (optional)"
          type="number"
          min={0}
          step="0.01"
          disabled={pending}
        />
        <Field
          id="totalCost"
          label="Total cost (optional)"
          type="number"
          min={0}
          step="0.01"
          disabled={pending}
        />
      </div>
      <Field
        id="photo"
        label="Invoice, job card or service-book photo"
        type="file"
        accept="image/jpeg,image/png"
        disabled={pending}
        hint="JPEG or PNG. Stored privately. Recommended: the verifier compares the record with this photo."
      />
      <FormMessage state={state} />
      <div>
        <Button type="submit" size="lg" disabled={pending} aria-busy={pending}>
          {pending ? "Saving…" : "Record service"}
        </Button>
      </div>
    </form>
  );
}

/** Verify or reject. The creator is refused by the database (DEC-24); the form just says so up front. */
export function VerifyRecordForm({
  recordId,
  createdByMe,
}: {
  recordId: string;
  createdByMe: boolean;
}) {
  const [state, action, pending] = useActionState(verifyRecordAction, idle);
  if (createdByMe)
    return (
      <p className="text-muted-foreground text-sm">
        You created this record, so someone else must verify it (DEC-24).
      </p>
    );
  return (
    <form action={action} className="flex flex-col gap-3" noValidate>
      <input type="hidden" name="recordId" value={recordId} />
      <div className="flex flex-col gap-2">
        <Label htmlFor={`reason-${recordId}`}>
          Reason (required to reject)
        </Label>
        <Textarea
          id={`reason-${recordId}`}
          name="reason"
          rows={2}
          maxLength={500}
          disabled={pending}
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

/** The only way a verified record changes: an audited reversal with a reason. */
export function ReverseVerificationForm({ recordId }: { recordId: string }) {
  const [state, action, pending] = useActionState(
    reverseVerificationAction,
    idle,
  );
  return (
    <form action={action} className="flex flex-col gap-3" noValidate>
      <input type="hidden" name="recordId" value={recordId} />
      <Field
        id={`reverse-${recordId}`}
        name="reason"
        label="Reason for reversing this verification"
        maxLength={500}
        required
        disabled={pending}
      />
      <div>
        <SubmitButton pending={pending} pendingLabel="Reversing…">
          Reverse verification
        </SubmitButton>
      </div>
      <FormMessage state={state} />
    </form>
  );
}

/** Opens the evidence photo through the logged, short-lived signed URL (ARCH §6.6). */
export function ViewEvidenceButton({
  evidenceFileId,
  recordId,
}: {
  evidenceFileId: string;
  recordId: string;
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
              purpose: "service record verification",
              relatedEntityType: "service_record",
              relatedEntityId: recordId,
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
