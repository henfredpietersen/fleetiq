"use client";

import { useActionState } from "react";
import { Badge } from "@/components/ui/badge";
import {
  idle,
  type ActionState,
} from "@/modules/fleet-vehicles/domain/action-state";
import {
  Field,
  FormMessage,
  SubmitButton,
} from "@/modules/fleet-vehicles/ui/form-parts";
import { crossesMidnight } from "../domain/shift-times";
import {
  archiveTemplateAction,
  createTemplateAction,
  updateTemplateAction,
} from "../server/actions";

/** Start–end with a "crosses midnight" badge, from the stored times. */
export function TemplateTimes({ start, end }: { start: string; end: string }) {
  const s = start.slice(0, 5);
  const e = end.slice(0, 5);
  return (
    <span className="flex flex-wrap items-center gap-2">
      <span className="tabular-nums">
        {s}–{e}
      </span>
      {crossesMidnight(s, e) ? (
        <Badge variant="warning">Crosses midnight</Badge>
      ) : null}
    </span>
  );
}

function Fields({
  idPrefix,
  pending,
  defaults,
}: {
  idPrefix: string;
  pending: boolean;
  defaults?: { name: string; start: string; end: string };
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <Field
        id={`${idPrefix}-name`}
        name="name"
        label="Name"
        defaultValue={defaults?.name}
        maxLength={100}
        required
        disabled={pending}
      />
      <Field
        id={`${idPrefix}-start`}
        name="startTime"
        label="Start time"
        type="time"
        defaultValue={defaults?.start}
        required
        disabled={pending}
      />
      <Field
        id={`${idPrefix}-end`}
        name="endTime"
        label="End time"
        type="time"
        defaultValue={defaults?.end}
        required
        disabled={pending}
        hint="An end time earlier than the start time means the shift ends the next day."
      />
    </div>
  );
}

export function CreateTemplateForm({ branchId }: { branchId: string }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    createTemplateAction,
    idle,
  );
  return (
    <form action={action} className="flex flex-col gap-4" noValidate>
      <input type="hidden" name="branchId" value={branchId} />
      <Fields idPrefix="new" pending={pending} />
      <div>
        <SubmitButton pending={pending} pendingLabel="Creating…">
          Create template
        </SubmitButton>
      </div>
      <FormMessage state={state} />
    </form>
  );
}

export function EditTemplateForm({
  templateId,
  name,
  start,
  end,
}: {
  templateId: string;
  name: string;
  start: string;
  end: string;
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    updateTemplateAction,
    idle,
  );
  return (
    <form action={action} className="flex flex-col gap-4" noValidate>
      <input type="hidden" name="templateId" value={templateId} />
      <Fields
        idPrefix={`edit-${templateId}`}
        pending={pending}
        defaults={{ name, start: start.slice(0, 5), end: end.slice(0, 5) }}
      />
      <p className="text-muted-foreground text-xs">
        Shifts already created from this template keep their own times.
      </p>
      <div>
        <SubmitButton pending={pending} pendingLabel="Saving…">
          Save changes
        </SubmitButton>
      </div>
      <FormMessage state={state} />
    </form>
  );
}

export function ArchiveTemplateForm({ templateId }: { templateId: string }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    archiveTemplateAction,
    idle,
  );
  return (
    <form action={action} className="flex flex-col gap-3" noValidate>
      <input type="hidden" name="templateId" value={templateId} />
      <Field
        id={`archive-${templateId}-reason`}
        name="reason"
        label="Reason for archiving"
        hint="An archived template cannot be edited or used to generate shifts. Existing shifts are not changed."
        maxLength={500}
        required
        disabled={pending}
      />
      <div>
        <SubmitButton pending={pending} pendingLabel="Archiving…">
          Archive template
        </SubmitButton>
      </div>
      <FormMessage state={state} />
    </form>
  );
}
