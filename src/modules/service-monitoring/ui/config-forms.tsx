"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { idle } from "@/modules/fleet-vehicles/domain/action-state";
import {
  Field,
  FormMessage,
  SelectField,
  SubmitButton,
  TextareaField,
} from "@/modules/fleet-vehicles/ui/form-parts";
import {
  changeDefaultAction,
  decideOverrideAction,
  requestOverrideAction,
} from "../server/actions";

type Values = {
  serviceIntervalKm?: number;
  earlyToleranceKm?: number;
  lateToleranceKm?: number;
  serviceIntervalDays?: number | null;
  earlyToleranceDays?: number | null;
  lateToleranceDays?: number | null;
};

/** The numeric fields shared by the default and override forms. Time tolerances are DEC-11 (Proposed): no built-in value. */
function ValueFields({
  defaults,
  disabled,
}: {
  defaults?: Values;
  disabled: boolean;
}) {
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field
          id="serviceIntervalKm"
          label="Interval (km)"
          type="number"
          min={1}
          step={1}
          inputMode="numeric"
          required
          defaultValue={defaults?.serviceIntervalKm}
          disabled={disabled}
        />
        <Field
          id="earlyToleranceKm"
          label="Early tolerance (km)"
          type="number"
          min={0}
          step={1}
          inputMode="numeric"
          required
          defaultValue={defaults?.earlyToleranceKm}
          disabled={disabled}
        />
        <Field
          id="lateToleranceKm"
          label="Late tolerance (km)"
          type="number"
          min={0}
          step={1}
          inputMode="numeric"
          required
          defaultValue={defaults?.lateToleranceKm}
          disabled={disabled}
        />
      </div>
      <fieldset className="flex flex-col gap-3">
        <legend className="text-sm font-medium">Time basis (optional)</legend>
        <p className="text-muted-foreground text-xs">
          Leave all three empty for a kilometre-only schedule. If you set an
          interval, enter both tolerances too: they are configurable values with
          no built-in default (DEC-11, proposed).
        </p>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field
            id="serviceIntervalDays"
            label="Interval (days)"
            type="number"
            min={1}
            step={1}
            inputMode="numeric"
            defaultValue={defaults?.serviceIntervalDays ?? undefined}
            disabled={disabled}
          />
          <Field
            id="earlyToleranceDays"
            label="Early tolerance (days)"
            type="number"
            min={0}
            step={1}
            inputMode="numeric"
            defaultValue={defaults?.earlyToleranceDays ?? undefined}
            disabled={disabled}
          />
          <Field
            id="lateToleranceDays"
            label="Late tolerance (days)"
            type="number"
            min={0}
            step={1}
            inputMode="numeric"
            defaultValue={defaults?.lateToleranceDays ?? undefined}
            disabled={disabled}
          />
        </div>
      </fieldset>
    </>
  );
}

/** Company default: effective-dated change (the old values stay as history). Current values come from the database. */
export function ChangeDefaultForm({ current }: { current: Values }) {
  const [state, action, pending] = useActionState(changeDefaultAction, idle);
  return (
    <form action={action} className="flex max-w-3xl flex-col gap-4" noValidate>
      <ValueFields defaults={current} disabled={pending} />
      <Field
        id="manufacturerReference"
        label="Manufacturer reference (optional)"
        maxLength={200}
        disabled={pending}
      />
      <TextareaField
        id="reason"
        label="Reason for the change"
        maxLength={1000}
        required
        disabled={pending}
      />
      <FormMessage state={state} />
      <div>
        <SubmitButton pending={pending} pendingLabel="Saving…">
          Save new company default
        </SubmitButton>
      </div>
    </form>
  );
}

export type VehicleChoice = {
  id: string;
  label: string;
  make: string;
  model: string;
  vehicleCategory: string;
};

/** Override request: creates an approval request only. It takes effect when a different manager approves it (DEC-24). */
export function RequestOverrideForm({
  vehicles,
  submissionId,
}: {
  vehicles: VehicleChoice[];
  submissionId: string;
}) {
  const [state, action, pending] = useActionState(requestOverrideAction, idle);
  const [scope, setScope] = useState<"vehicle" | "make_model" | "category">(
    "vehicle",
  );
  return (
    <form action={action} className="flex max-w-3xl flex-col gap-4" noValidate>
      <input type="hidden" name="clientSubmissionId" value={submissionId} />
      <SelectField
        id="scope"
        label="Applies to"
        value={scope}
        onChange={(e) => setScope(e.target.value as typeof scope)}
        disabled={pending}
      >
        <option value="vehicle">One vehicle</option>
        <option value="make_model">A make and model</option>
        <option value="category">A vehicle category</option>
      </SelectField>
      {scope === "vehicle" ? (
        <SelectField
          id="vehicleId"
          label="Vehicle"
          required
          defaultValue=""
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
      ) : null}
      {scope === "make_model" ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            id="make"
            label="Make"
            maxLength={100}
            required
            disabled={pending}
          />
          <Field
            id="model"
            label="Model"
            maxLength={100}
            required
            disabled={pending}
          />
        </div>
      ) : null}
      {scope === "category" ? (
        <Field
          id="vehicleCategory"
          label="Category"
          maxLength={100}
          required
          disabled={pending}
        />
      ) : null}
      <ValueFields disabled={pending} />
      <Field
        id="manufacturerReference"
        label="Manufacturer reference (optional)"
        maxLength={200}
        disabled={pending}
      />
      <TextareaField
        id="reason"
        label="Reason (required)"
        maxLength={1000}
        required
        disabled={pending}
      />
      <FormMessage state={state} />
      <div>
        <SubmitButton pending={pending} pendingLabel="Requesting…">
          Request override
        </SubmitButton>
      </div>
    </form>
  );
}

export function DecideOverrideForm({ approvalId }: { approvalId: string }) {
  const [state, action, pending] = useActionState(decideOverrideAction, idle);
  return (
    <form action={action} className="flex flex-col gap-3" noValidate>
      <input type="hidden" name="approvalId" value={approvalId} />
      <div className="flex flex-col gap-2">
        <Label htmlFor={`notes-${approvalId}`}>Notes (optional)</Label>
        <textarea
          id={`notes-${approvalId}`}
          name="notes"
          rows={2}
          maxLength={1000}
          className="border-input rounded-md border px-3 py-2 text-sm"
          disabled={pending}
        />
      </div>
      <div className="flex gap-3">
        <Button
          type="submit"
          name="decision"
          value="approved"
          disabled={pending}
        >
          Approve
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
