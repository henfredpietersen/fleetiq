"use client";

import { useActionState, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
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
import { generateShiftsAction } from "../server/actions";

export type TemplateChoice = { id: string; label: string };

/**
 * Generate shifts from a template over a date range (max 31 days). Native <dialog>: focus trap, Escape and a backdrop
 * without another dependency. The submission id stays the same until a success, so a retry after a dropped
 * connection returns the same created/skipped result instead of duplicating anything.
 */
export function GenerateShiftsDialog({
  templates,
  defaultFrom,
  defaultTo,
}: {
  templates: TemplateChoice[];
  defaultFrom: string;
  defaultTo: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [submissionId, setSubmissionId] = useState(() => crypto.randomUUID());
  // A success renews the submission id (set from the action callback, not an effect); a failure keeps it so a retry is idempotent.
  const [state, action, pending] = useActionState<ActionState, FormData>(
    async (prev, form) => {
      const result = await generateShiftsAction(prev, form);
      if (result.status === "success") setSubmissionId(crypto.randomUUID());
      return result;
    },
    idle,
  );

  return (
    <>
      <Button
        type="button"
        variant="outline"
        disabled={templates.length === 0}
        onClick={() => ref.current?.showModal()}
      >
        Generate shifts…
      </Button>
      <dialog
        ref={ref}
        aria-labelledby="generate-title"
        className="bg-background text-foreground m-auto w-full max-w-lg rounded-lg border p-6 shadow-lg backdrop:bg-black/40"
      >
        <form action={action} className="flex flex-col gap-4" noValidate>
          <h2 id="generate-title" className="text-lg font-semibold">
            Generate shifts from a template
          </h2>
          <input type="hidden" name="clientSubmissionId" value={submissionId} />
          <SelectField
            id="gen-template"
            name="templateId"
            label="Template"
            required
            disabled={pending}
            defaultValue={templates[0]?.id}
          >
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </SelectField>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              id="gen-from"
              name="from"
              label="From"
              type="date"
              defaultValue={defaultFrom}
              required
              disabled={pending}
            />
            <Field
              id="gen-to"
              name="to"
              label="To"
              type="date"
              defaultValue={defaultTo}
              required
              disabled={pending}
              hint="At most 31 days. Days that already have a scheduled shift from this template are skipped."
            />
          </div>
          <FormMessage state={state} />
          <div className="flex flex-wrap gap-3">
            <SubmitButton pending={pending} pendingLabel="Generating…">
              Generate
            </SubmitButton>
            <Button
              type="button"
              variant="ghost"
              size="lg"
              onClick={() => ref.current?.close()}
            >
              Close
            </Button>
          </div>
        </form>
      </dialog>
    </>
  );
}
