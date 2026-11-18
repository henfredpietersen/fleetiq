"use client";

import { useActionState, useState } from "react";
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
import { cancelShiftAction, createShiftAction } from "../server/actions";

export type DepartmentChoice = { id: string; name: string };

/** Ad hoc shift (no template). One submission id per form instance, renewed after a success, so a retry is idempotent. */
export function AdHocShiftForm({
  branchId,
  departments,
  defaultDate,
}: {
  branchId: string;
  departments: DepartmentChoice[];
  defaultDate: string;
}) {
  const [submissionId, setSubmissionId] = useState(() => crypto.randomUUID());
  // A success renews the submission id (set from the action callback, not an effect); a failure keeps it so a retry is idempotent.
  const [state, action, pending] = useActionState<ActionState, FormData>(
    async (prev, form) => {
      const result = await createShiftAction(prev, form);
      if (result.status === "success") setSubmissionId(crypto.randomUUID());
      return result;
    },
    idle,
  );
  return (
    <form action={action} className="flex flex-col gap-4" noValidate>
      <input type="hidden" name="branchId" value={branchId} />
      <input type="hidden" name="clientSubmissionId" value={submissionId} />
      <div className="grid gap-4 sm:grid-cols-4">
        <Field
          id="shiftDate"
          label="Date"
          type="date"
          defaultValue={defaultDate}
          required
          disabled={pending}
        />
        <Field
          id="startTime"
          label="Start time"
          type="time"
          required
          disabled={pending}
        />
        <Field
          id="endTime"
          label="End time"
          type="time"
          required
          disabled={pending}
          hint="Earlier than the start time = ends the next day."
        />
        <SelectField
          id="departmentId"
          label="Department (optional)"
          disabled={pending}
          defaultValue=""
        >
          <option value="">None</option>
          {departments.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </SelectField>
      </div>
      <div>
        <SubmitButton pending={pending} pendingLabel="Creating…">
          Create shift
        </SubmitButton>
      </div>
      <FormMessage state={state} />
    </form>
  );
}

export function CancelShiftForm({ shiftId }: { shiftId: string }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    cancelShiftAction,
    idle,
  );
  return (
    <form action={action} className="flex flex-col gap-3" noValidate>
      <input type="hidden" name="shiftId" value={shiftId} />
      <Field
        id={`cancel-${shiftId}-reason`}
        name="reason"
        label="Reason for cancelling"
        maxLength={500}
        required
        disabled={pending}
      />
      <div>
        <SubmitButton pending={pending} pendingLabel="Cancelling…">
          Cancel shift
        </SubmitButton>
      </div>
      <FormMessage state={state} />
    </form>
  );
}
