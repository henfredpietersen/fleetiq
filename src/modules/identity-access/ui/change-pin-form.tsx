"use client";

import { useActionState } from "react";
import { changePinAction } from "../server/actions";
import { idle } from "./action-state";
import { Field, FormMessage, SubmitButton } from "./form-parts";

export function ChangePinForm({ pinLength }: { pinLength: number }) {
  const [state, action, pending] = useActionState(changePinAction, idle);
  return (
    <form action={action} className="flex flex-col gap-5" noValidate>
      <Field
        id="newPin"
        label="New PIN"
        type="password"
        inputMode="numeric"
        pattern="[0-9]*"
        autoComplete="new-password"
        hint={`${pinLength} digits. No sequences (123456) or repeats (111111, 121212).`}
        required
      />
      <Field
        id="confirmPin"
        label="Confirm new PIN"
        type="password"
        inputMode="numeric"
        pattern="[0-9]*"
        autoComplete="new-password"
        required
      />
      <FormMessage state={state} />
      <SubmitButton pending={pending} pendingLabel="Saving…">
        Save new PIN
      </SubmitButton>
    </form>
  );
}
