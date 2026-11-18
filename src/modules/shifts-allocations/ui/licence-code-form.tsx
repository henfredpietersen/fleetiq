"use client";

import { useActionState } from "react";
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
import { LICENCE_CODES, LICENCE_CODE_GUIDANCE } from "../domain/licence-codes";
import { setRequiredLicenceCodeAction } from "../server/allocation-actions";

/** "Required licence code" for a vehicle. Only vehicle.manage holders see the form; the database enforces it. */
export function RequiredLicenceCodeForm({
  vehicleId,
  current,
}: {
  vehicleId: string;
  current: string | null;
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    setRequiredLicenceCodeAction,
    idle,
  );
  return (
    <form action={action} className="flex max-w-xl flex-col gap-4" noValidate>
      <input type="hidden" name="vehicleId" value={vehicleId} />
      <SelectField
        id="code"
        label="Required licence code"
        defaultValue={current ?? ""}
        disabled={pending}
        hint="Leave empty if it is not known: the licence class is then not checked when this vehicle is allocated."
      >
        <option value="">Not configured</option>
        {LICENCE_CODES.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </SelectField>
      <Field
        id="reason"
        label="Reason for the change"
        maxLength={500}
        required
        disabled={pending}
      />
      <div>
        <SubmitButton pending={pending} pendingLabel="Saving…">
          Save required licence code
        </SubmitButton>
      </div>
      <FormMessage state={state} />
    </form>
  );
}

export function LicenceCodeGuidance() {
  return (
    <table className="text-sm">
      <caption className="text-muted-foreground pb-2 text-left text-xs">
        Guidance (by gross vehicle mass, GVM)
      </caption>
      <tbody>
        {LICENCE_CODE_GUIDANCE.map((g) => (
          <tr key={g.codes}>
            <th
              scope="row"
              className="pr-4 text-left font-medium whitespace-nowrap"
            >
              {g.codes}
            </th>
            <td className="text-muted-foreground py-0.5">{g.text}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
