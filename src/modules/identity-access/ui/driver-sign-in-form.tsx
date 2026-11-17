"use client";

import { useActionState } from "react";
import { driverSignInAction } from "../server/actions";
import { idle } from "./action-state";
import { Field, FormMessage, SubmitButton } from "./form-parts";

export function DriverSignInForm({ notice }: { notice?: string }) {
  const [state, action, pending] = useActionState(driverSignInAction, idle);
  return (
    <form action={action} className="flex flex-col gap-5" noValidate>
      {notice ? (
        <p className="text-muted-foreground text-sm" role="status">
          {notice}
        </p>
      ) : null}
      <Field
        id="employeeNumber"
        label="Employee number"
        autoComplete="username"
        autoCapitalize="characters"
        autoCorrect="off"
        spellCheck={false}
        required
      />
      <Field
        id="pin"
        label="PIN"
        type="password"
        inputMode="numeric"
        pattern="[0-9]*"
        autoComplete="current-password"
        required
      />
      <FormMessage state={state} />
      <SubmitButton pending={pending} pendingLabel="Signing in…">
        Sign in
      </SubmitButton>
    </form>
  );
}
