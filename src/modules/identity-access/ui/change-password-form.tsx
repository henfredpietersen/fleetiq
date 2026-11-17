"use client";

import { useActionState } from "react";
import { changePasswordAction } from "../server/actions";
import { idle } from "./action-state";
import { Field, FormMessage, SubmitButton } from "./form-parts";

export function ChangePasswordForm({ minLength }: { minLength: number }) {
  const [state, action, pending] = useActionState(changePasswordAction, idle);
  return (
    <form action={action} className="flex flex-col gap-5" noValidate>
      <Field
        id="newPassword"
        label="New password"
        type="password"
        autoComplete="new-password"
        hint={`At least ${minLength} characters.`}
        required
      />
      <Field
        id="confirmPassword"
        label="Confirm new password"
        type="password"
        autoComplete="new-password"
        required
      />
      <FormMessage state={state} />
      <SubmitButton pending={pending} pendingLabel="Saving…">
        Save new password
      </SubmitButton>
    </form>
  );
}
