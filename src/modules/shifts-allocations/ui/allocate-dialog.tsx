"use client";

import { useActionState, useRef, useState, useTransition } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  idle,
  type ActionState,
} from "@/modules/fleet-vehicles/domain/action-state";
import {
  FormMessage,
  SelectField,
  SubmitButton,
  TextareaField,
} from "@/modules/fleet-vehicles/ui/form-parts";
import { explainEligibility } from "../domain/allocation-text";
import {
  checkEligibilityAction,
  requestAllocationAction,
  type EligibilityReply,
} from "../server/allocation-actions";

export type Choice = { id: string; label: string };

/**
 * Allocate a vehicle and driver to a shift. As the three choices are made the database is asked whether the
 * combination is allowed and the answer is shown in plain words BEFORE submitting; on submit the database re-checks
 * everything. A licence class mismatch is submitted as a request for approval (a reason is required). The submission id
 * stays the same until a success, so a retry after a dropped connection returns the same result.
 */
export function AllocateDialog({
  shifts,
  vehicles,
  drivers,
}: {
  shifts: Choice[];
  vehicles: Choice[];
  drivers: Choice[];
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [submissionId, setSubmissionId] = useState(() => crypto.randomUUID());
  const [pick, setPick] = useState({
    shiftId: shifts[0]?.id ?? "",
    vehicleId: "",
    driverId: "",
  });
  const [reply, setReply] = useState<EligibilityReply | null>(null);
  const [checking, startCheck] = useTransition();
  const [state, action, pending] = useActionState<ActionState, FormData>(
    async (prev, form) => {
      const result = await requestAllocationAction(prev, form);
      if (result.status === "success") {
        setSubmissionId(crypto.randomUUID());
        setReply(null);
        setPick((p) => ({ ...p, vehicleId: "", driverId: "" }));
      }
      return result;
    },
    idle,
  );

  function change(next: Partial<typeof pick>) {
    const p = { ...pick, ...next };
    setPick(p);
    setReply(null);
    if (p.shiftId && p.vehicleId && p.driverId) {
      startCheck(async () => {
        setReply(await checkEligibilityAction(p));
      });
    }
  }

  const explained = reply?.ok ? explainEligibility(reply.result) : null;
  const needsOverride = reply?.ok === true && reply.result.needsOverride;
  const canSubmit = reply?.ok === true && reply.result.ok && !checking;

  return (
    <>
      <Button
        type="button"
        disabled={shifts.length === 0}
        onClick={() => ref.current?.showModal()}
      >
        Allocate…
      </Button>
      <dialog
        ref={ref}
        aria-labelledby="allocate-title"
        className="bg-background text-foreground m-auto w-full max-w-xl rounded-lg border p-6 shadow-lg backdrop:bg-black/40"
      >
        <form action={action} className="flex flex-col gap-4" noValidate>
          <h2 id="allocate-title" className="text-lg font-semibold">
            Allocate a vehicle and driver
          </h2>
          <input type="hidden" name="clientSubmissionId" value={submissionId} />
          <SelectField
            id="shiftId"
            label="Shift"
            required
            disabled={pending}
            value={pick.shiftId}
            onChange={(e) => change({ shiftId: e.target.value })}
          >
            {shifts.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </SelectField>
          <SelectField
            id="vehicleId"
            label="Vehicle (available, at this branch)"
            required
            disabled={pending}
            value={pick.vehicleId}
            onChange={(e) => change({ vehicleId: e.target.value })}
          >
            <option value="">Choose a vehicle…</option>
            {vehicles.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
              </option>
            ))}
          </SelectField>
          <SelectField
            id="driverId"
            label="Driver (active, at this branch)"
            required
            disabled={pending}
            value={pick.driverId}
            onChange={(e) => change({ driverId: e.target.value })}
          >
            <option value="">Choose a driver…</option>
            {drivers.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </SelectField>

          <div aria-live="polite" data-testid="eligibility">
            {checking ? (
              <p className="text-muted-foreground text-sm">Checking…</p>
            ) : reply && !reply.ok ? (
              <Alert variant="destructive">{reply.message}</Alert>
            ) : explained ? (
              <Alert
                variant={
                  explained.tone === "blocked"
                    ? "destructive"
                    : explained.tone === "warning"
                      ? "default"
                      : "success"
                }
              >
                {explained.lines.map((l) => (
                  <p key={l}>{l}</p>
                ))}
              </Alert>
            ) : (
              <p className="text-muted-foreground text-sm">
                Choose a shift, a vehicle and a driver to see whether it is
                allowed.
              </p>
            )}
          </div>

          {needsOverride ? (
            <TextareaField
              id="reason"
              label="Reason for the licence override"
              required
              maxLength={1000}
              disabled={pending}
            />
          ) : null}
          {needsOverride ? (
            <p className="text-muted-foreground -mt-2 text-xs">
              Another manager will review this. The driver cannot approve it.
            </p>
          ) : null}

          <FormMessage state={state} />
          <div className="flex flex-wrap gap-3">
            <SubmitButton
              pending={pending}
              pendingLabel="Saving…"
              disabled={!canSubmit}
            >
              {needsOverride ? "Request approval" : "Allocate"}
            </SubmitButton>
            <Button
              type="button"
              variant="ghost"
              size="lg"
              onClick={() => ref.current?.close()}
            >
              Close
            </Button>
          </div>
        </form>
      </dialog>
    </>
  );
}
