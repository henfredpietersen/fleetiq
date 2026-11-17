"use client";

import { useActionState } from "react";
import { staffSignInAction } from "../server/actions";
import { idle } from "./action-state";
import { Field, FormMessage, SubmitButton } from "./form-parts";

export function StaffSignInForm({ notice }: { notice?: string }) {
  const [state, action, pending] = useActionState(staffSignInAction, idle);
  return (
    <form action={action} className="flex flex-col gap-5" noValidate>
      {notice ? (
        <p className="text-muted-foreground text-sm" role="status">
          {notice}
        </p>
      ) : null}
      <Field
        id="email"
        label="Email"
        type="email"
        autoComplete="username"
        required
      />
      <Field
        id="password"
        label="Password"
        type="password"
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
