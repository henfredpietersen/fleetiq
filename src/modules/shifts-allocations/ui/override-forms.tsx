"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import {
  idle,
  type ActionState,
} from "@/modules/fleet-vehicles/domain/action-state";
import { Field, FormMessage } from "@/modules/fleet-vehicles/ui/form-parts";
import { decideOverrideAction } from "../server/allocation-actions";

/**
 * Approve / reject one licence override. Approve is hidden for the requester and for the driver; the database
 * refuses both anyway (DEC-24), so this only saves a click.
 */
export function DecideOverrideForm({
  approvalId,
  canApprove,
  canReject,
}: {
  approvalId: string;
  canApprove: boolean;
  canReject: boolean;
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    decideOverrideAction,
    idle,
  );
  if (!canApprove && !canReject)
    return (
      <p className="text-muted-foreground text-xs">
        Another manager must decide this request.
      </p>
    );
  return (
    <form action={action} className="flex max-w-sm flex-col gap-3" noValidate>
      <input type="hidden" name="approvalId" value={approvalId} />
      <Field
        id={`notes-${approvalId}`}
        name="notes"
        label="Notes (optional)"
        maxLength={1000}
        disabled={pending}
      />
      <div className="flex gap-3">
        {canApprove ? (
          <Button
            type="submit"
            name="decision"
            value="approved"
            disabled={pending}
          >
            Approve
          </Button>
        ) : null}
        {canReject ? (
          <Button
            type="submit"
            name="decision"
            value="rejected"
            variant="outline"
            disabled={pending}
          >
            Reject
          </Button>
        ) : null}
      </div>
      <FormMessage state={state} />
    </form>
  );
}
