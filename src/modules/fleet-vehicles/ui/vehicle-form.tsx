"use client";

import { useActionState } from "react";
import { idle } from "../domain/action-state";
import { ADMIN_STATUSES, ADMIN_STATUS_LABELS } from "../domain/vehicle-schema";
import { createVehicleAction, updateVehicleAction } from "../server/actions";
import { Field, FormMessage, SelectField, SubmitButton } from "./form-parts";

export type VehicleFormValues = {
  id?: string;
  fleet_number?: string;
  registration_number?: string;
  make?: string;
  model?: string;
  vehicle_category?: string;
  variant?: string | null;
  model_year?: number | null;
  vin?: string | null;
  engine_number?: string | null;
  fuel_type?: string | null;
  transmission?: string | null;
  administrative_status?: string;
};

type Props =
  | {
      mode: "create";
      branches: { id: string; name: string }[];
      defaults?: VehicleFormValues;
    }
  | { mode: "edit"; defaults: VehicleFormValues; readOnly?: boolean };

/** Create (with the first branch assignment) or edit. Caches (branch, odometer) are not editable here. */
export function VehicleForm(props: Props) {
  const create = props.mode === "create";
  const [state, action, pending] = useActionState(
    create ? createVehicleAction : updateVehicleAction,
    idle,
  );
  const d = props.defaults ?? {};
  const readOnly = !create && props.readOnly === true;

  return (
    <form action={action} className="flex flex-col gap-5" noValidate>
      {!create && d.id ? <input type="hidden" name="id" value={d.id} /> : null}
      <fieldset
        disabled={readOnly || pending}
        className="grid gap-5 sm:grid-cols-2"
      >
        {create ? (
          <SelectField
            id="branchId"
            label="Branch"
            hint="The vehicle's first branch assignment. Later moves need an approved transfer."
            required
            defaultValue=""
          >
            <option value="" disabled>
              Choose a branch…
            </option>
            {props.branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </SelectField>
        ) : null}
        <Field
          id="registrationNumber"
          label="Registration number"
          defaultValue={d.registration_number}
          autoCapitalize="characters"
          maxLength={20}
          required
        />
        <Field
          id="fleetNumber"
          label="Fleet number"
          defaultValue={d.fleet_number}
          maxLength={50}
          required
        />
        <Field
          id="make"
          label="Make"
          defaultValue={d.make}
          maxLength={100}
          required
        />
        <Field
          id="model"
          label="Model"
          defaultValue={d.model}
          maxLength={100}
          required
        />
        <Field
          id="variant"
          label="Variant"
          defaultValue={d.variant ?? ""}
          maxLength={100}
        />
        <Field
          id="modelYear"
          label="Model year"
          type="number"
          inputMode="numeric"
          min={1900}
          max={2100}
          defaultValue={d.model_year ?? ""}
        />
        <Field
          id="vehicleCategory"
          label="Category"
          defaultValue={d.vehicle_category}
          maxLength={100}
          required
        />
        <Field
          id="vin"
          label="VIN / chassis number"
          defaultValue={d.vin ?? ""}
          autoCapitalize="characters"
          maxLength={30}
        />
        <Field
          id="engineNumber"
          label="Engine number"
          defaultValue={d.engine_number ?? ""}
          maxLength={50}
        />
        <Field
          id="fuelType"
          label="Fuel type"
          defaultValue={d.fuel_type ?? ""}
          maxLength={50}
        />
        <Field
          id="transmission"
          label="Transmission"
          defaultValue={d.transmission ?? ""}
          maxLength={50}
        />
        <SelectField
          id="administrativeStatus"
          label="Administrative status"
          hint="Allocated / in use are derived from allocations and are not set here."
          defaultValue={d.administrative_status ?? "available"}
        >
          {ADMIN_STATUSES.map((s) => (
            <option key={s} value={s}>
              {ADMIN_STATUS_LABELS[s]}
            </option>
          ))}
        </SelectField>
      </fieldset>
      <FormMessage state={state} />
      {readOnly ? null : (
        <div>
          <SubmitButton
            pending={pending}
            pendingLabel={create ? "Creating…" : "Saving…"}
          >
            {create ? "Create vehicle" : "Save changes"}
          </SubmitButton>
        </div>
      )}
    </form>
  );
}
