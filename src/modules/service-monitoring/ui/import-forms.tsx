"use client";

import { useActionState, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import {
  idle,
  type ActionState,
} from "@/modules/fleet-vehicles/domain/action-state";
import { Field, FormMessage } from "@/modules/fleet-vehicles/ui/form-parts";
import { uploadEvidencePhoto } from "@/modules/evidence-storage/ui/upload-evidence";
import { attachEvidenceAction, stageImportAction } from "../server/actions";

/** CSV upload: the file is read in the browser and sent as text; the database stages and validates every row. */
export function CsvImportForm({ submissionId }: { submissionId: string }) {
  const [state, action, pending] = useActionState(stageImportAction, idle);
  const [csv, setCsv] = useState("");
  const [name, setName] = useState("");
  const [readError, setReadError] = useState<string | null>(null);
  return (
    <form action={action} className="flex max-w-xl flex-col gap-4" noValidate>
      <input type="hidden" name="clientSubmissionId" value={submissionId} />
      <input type="hidden" name="csvText" value={csv} />
      <input type="hidden" name="filename" value={name} />
      <Field
        id="file"
        label="CSV file"
        type="file"
        accept=".csv,text/csv"
        required
        disabled={pending}
        hint="Columns: registration_number, service_date (YYYY-MM-DD), odometer_km, service_type; optional supplier_name, job_reference, invoice_reference. Up to 500 rows."
        onChange={async (e) => {
          setReadError(null);
          const f = e.target.files?.[0];
          if (!f) {
            setCsv("");
            setName("");
            return;
          }
          try {
            setCsv(await f.text());
            setName(f.name);
          } catch {
            setReadError("That file could not be read.");
          }
        }}
      />
      {readError ? (
        <p role="alert" className="text-destructive text-sm">
          {readError}
        </p>
      ) : null}
      <FormMessage state={state} />
      <div>
        <Button
          type="submit"
          size="lg"
          disabled={pending || csv === ""}
          aria-busy={pending}
        >
          {pending ? "Validating…" : "Upload and validate"}
        </Button>
      </div>
    </form>
  );
}

/** Per valid row: attach the evidence photo -> a `recorded` historical_import record (verified separately, DEC-20). */
export function AttachEvidenceForm({
  rowId,
  batchId,
  branchId,
}: {
  rowId: string;
  batchId: string;
  branchId: string;
}) {
  const [state, setState] = useState<ActionState>(idle);
  const [pending, startTransition] = useTransition();
  const [submissionId] = useState(() => crypto.randomUUID());
  return (
    <form
      className="flex flex-col gap-2"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const file = new FormData(e.currentTarget).get("photo");
        startTransition(async () => {
          setState(idle);
          if (!(file instanceof File) || file.size === 0)
            return setState({
              status: "error",
              message: "Choose the invoice, job card or service-book photo.",
            });
          const up = await uploadEvidencePhoto({
            file,
            purpose: "service_record",
            branchId,
            submissionId,
          });
          if (!up.ok) return setState({ status: "error", message: up.message });
          const data = new FormData();
          data.set("rowId", rowId);
          data.set("batchId", batchId);
          data.set("evidenceFileId", up.evidenceFileId);
          data.set("clientSubmissionId", submissionId);
          setState(await attachEvidenceAction(idle, data));
        });
      }}
    >
      <Field
        id={`photo-${rowId}`}
        name="photo"
        label="Evidence photo"
        type="file"
        accept="image/jpeg,image/png"
        required
        disabled={pending}
      />
      <FormMessage state={state} />
      <div>
        <Button type="submit" disabled={pending} aria-busy={pending}>
          {pending ? "Attaching…" : "Attach and create record"}
        </Button>
      </div>
    </form>
  );
}
