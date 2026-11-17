"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { idle } from "@/modules/identity-access/ui/action-state";
import {
  Field,
  FormMessage,
  SubmitButton,
} from "@/modules/identity-access/ui/form-parts";
import { SecretReveal } from "@/modules/identity-access/ui/secret-reveal";
import {
  createDriverAction,
  resetDriverPinAction,
  setDriverStatusAction,
  updateDriverAction,
} from "../server/actions";

export function CreateDriverForm({
  branches,
}: {
  branches: { id: string; name: string }[];
}) {
  const [state, action, pending] = useActionState(createDriverAction, idle);
  return (
    <>
      <form action={action} className="flex max-w-xl flex-col gap-5" noValidate>
        <div className="flex flex-col gap-2">
          <Label htmlFor="branchId">Branch</Label>
          <Select
            id="branchId"
            name="branchId"
            required
            defaultValue={branches.length === 1 ? branches[0].id : ""}
          >
            <option value="" disabled>
              Choose a branch
            </option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
        </div>
        <Field
          id="employeeNumber"
          label="Employee number"
          hint="Letters, digits and hyphens, up to 20 characters. The driver signs in with this and a PIN."
          autoCapitalize="characters"
          autoComplete="off"
          maxLength={20}
          required
        />
        <Field id="displayName" label="Full name" maxLength={200} required />
        <Field id="phone" label="Phone (optional)" type="tel" maxLength={40} />
        <FormMessage state={state} />
        <div>
          <SubmitButton pending={pending} pendingLabel="Creating…">
            Create driver and issue PIN
          </SubmitButton>
        </div>
      </form>
      {state.status === "success" && state.revealed ? (
        <SecretReveal
          title="Temporary PIN"
          label={state.revealed.label}
          value={state.revealed.value}
          note="Give this PIN to the driver. They must change it the first time they sign in."
        />
      ) : null}
    </>
  );
}

export function EditDriverForm({
  driverId,
  displayName,
  phone,
}: {
  driverId: string;
  displayName: string;
  phone: string | null;
}) {
  const [state, action, pending] = useActionState(updateDriverAction, idle);
  return (
    <form action={action} className="flex max-w-xl flex-col gap-4" noValidate>
      <input type="hidden" name="driverId" value={driverId} />
      <Field
        id="displayName"
        label="Full name"
        defaultValue={displayName}
        maxLength={200}
        required
      />
      <Field
        id="phone"
        label="Phone"
        type="tel"
        defaultValue={phone ?? ""}
        maxLength={40}
      />
      <FormMessage state={state} />
      <div>
        <SubmitButton pending={pending} pendingLabel="Saving…">
          Save details
        </SubmitButton>
      </div>
    </form>
  );
}

export function DriverStatusForm({
  driverId,
  status,
}: {
  driverId: string;
  status: "active" | "inactive";
}) {
  const [state, action, pending] = useActionState(setDriverStatusAction, idle);
  const next = status === "active" ? "inactive" : "active";
  return (
    <form action={action} className="flex max-w-xl flex-col gap-3" noValidate>
      <input type="hidden" name="driverId" value={driverId} />
      <input type="hidden" name="status" value={next} />
      <div className="flex flex-col gap-2">
        <Label htmlFor="reason">
          Reason for {next === "inactive" ? "deactivating" : "reactivating"}
        </Label>
        <Textarea id="reason" name="reason" maxLength={500} required rows={2} />
      </div>
      <FormMessage state={state} />
      <div>
        <Button
          type="submit"
          variant={next === "inactive" ? "outline" : "default"}
          disabled={pending}
        >
          {pending
            ? "Saving…"
            : next === "inactive"
              ? "Deactivate driver"
              : "Reactivate driver"}
        </Button>
      </div>
    </form>
  );
}

export function ResetPinForm({ driverId }: { driverId: string }) {
  const [state, action, pending] = useActionState(resetDriverPinAction, idle);
  return (
    <>
      <form action={action} className="flex flex-col gap-3">
        <input type="hidden" name="driverId" value={driverId} />
        <FormMessage state={state} />
        <div>
          <Button type="submit" variant="outline" disabled={pending}>
            {pending ? "Resetting…" : "Reset PIN"}
          </Button>
        </div>
      </form>
      {state.status === "success" && state.revealed ? (
        <SecretReveal
          title="Temporary PIN"
          label={state.revealed.label}
          value={state.revealed.value}
          note="Give this PIN to the driver. It replaces their old one and they must change it at next sign-in."
        />
      ) : null}
    </>
  );
}
