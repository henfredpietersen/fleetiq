"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import {
  assignRoleAction,
  createStaffUserAction,
  resetStaffPasswordAction,
  revokeRoleAction,
} from "../server/admin-actions";
import { idle } from "./action-state";
import { Field, FormMessage, SubmitButton } from "./form-parts";
import { SecretReveal } from "./secret-reveal";

export function CreateStaffForm() {
  const [state, action, pending] = useActionState(createStaffUserAction, idle);
  return (
    <>
      <form action={action} className="flex max-w-xl flex-col gap-5" noValidate>
        <Field id="displayName" label="Full name" maxLength={200} required />
        <Field
          id="email"
          label="Email address"
          type="email"
          autoComplete="off"
          hint="They sign in with this address. A temporary password is generated for you to pass on."
          required
        />
        <FormMessage state={state} />
        <div>
          <SubmitButton pending={pending} pendingLabel="Creating…">
            Create staff user
          </SubmitButton>
        </div>
      </form>
      {state.status === "success" && state.revealed ? (
        <SecretReveal
          title="Temporary password"
          label={state.revealed.label}
          value={state.revealed.value}
          note="Give this to the new user. They must replace it at first sign-in."
        />
      ) : null}
    </>
  );
}

export function ResetPasswordForm({ userId }: { userId: string }) {
  const [state, action, pending] = useActionState(
    resetStaffPasswordAction,
    idle,
  );
  return (
    <>
      <form action={action} className="flex flex-col gap-3">
        <input type="hidden" name="userId" value={userId} />
        <FormMessage state={state} />
        <div>
          <Button type="submit" variant="outline" disabled={pending}>
            {pending ? "Resetting…" : "Reset password"}
          </Button>
        </div>
      </form>
      {state.status === "success" && state.revealed ? (
        <SecretReveal
          title="Temporary password"
          label={state.revealed.label}
          value={state.revealed.value}
          note="Give this to the user. They must replace it at next sign-in."
        />
      ) : null}
    </>
  );
}

export function AssignRoleForm({
  userId,
  roles,
  branches,
}: {
  userId: string;
  roles: { id: string; description: string }[];
  branches: { id: string; name: string }[];
}) {
  const [state, action, pending] = useActionState(assignRoleAction, idle);
  return (
    <form action={action} className="flex max-w-xl flex-col gap-4" noValidate>
      <input type="hidden" name="userId" value={userId} />
      <div className="flex flex-col gap-2">
        <Label htmlFor="roleId">Role</Label>
        <Select id="roleId" name="roleId" required defaultValue="">
          <option value="" disabled>
            Choose a role
          </option>
          {roles.map((r) => (
            <option key={r.id} value={r.id}>
              {r.description}
            </option>
          ))}
        </Select>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="branchId">Scope</Label>
        <Select id="branchId" name="branchId" defaultValue="">
          <option value="">All branches (company-wide)</option>
          {branches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name} only
            </option>
          ))}
        </Select>
      </div>
      <FormMessage state={state} />
      <div>
        <SubmitButton pending={pending} pendingLabel="Assigning…">
          Assign role
        </SubmitButton>
      </div>
    </form>
  );
}

export function RevokeRoleButton({
  grantId,
  userId,
  label,
}: {
  grantId: string;
  userId: string;
  label: string;
}) {
  const [state, action, pending] = useActionState(revokeRoleAction, idle);
  return (
    <form action={action} className="flex items-center gap-3">
      <input type="hidden" name="grantId" value={grantId} />
      <input type="hidden" name="userId" value={userId} />
      <Button
        type="submit"
        variant="outline"
        disabled={pending}
        aria-label={`End ${label}`}
      >
        {pending ? "Ending…" : "End"}
      </Button>
      {state.status === "error" ? (
        <span role="alert" className="text-destructive text-sm">
          {state.message}
        </span>
      ) : null}
    </form>
  );
}
