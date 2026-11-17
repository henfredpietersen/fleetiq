"use client";

import { useActionState, useState, useTransition } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  startMfaEnrolmentAction,
  verifyMfaAction,
  type EnrolmentState,
} from "../server/actions";
import { idle } from "./action-state";
import { Field, FormMessage, SubmitButton } from "./form-parts";

function CodeForm({ factorId }: { factorId?: string }) {
  const [state, action, pending] = useActionState(verifyMfaAction, idle);
  return (
    <form action={action} className="flex flex-col gap-5" noValidate>
      {factorId ? (
        <input type="hidden" name="factorId" value={factorId} />
      ) : null}
      <Field
        id="code"
        label="6-digit code"
        inputMode="numeric"
        pattern="[0-9]*"
        autoComplete="one-time-code"
        maxLength={7}
        required
      />
      <FormMessage state={state} />
      <SubmitButton pending={pending} pendingLabel="Checking…">
        Verify
      </SubmitButton>
    </form>
  );
}

/** mode "verify": an authenticator is already enrolled. mode "enrol": first-time set-up (DEC-34). */
export function MfaForm({ mode }: { mode: "enrol" | "verify" }) {
  const [enrolment, setEnrolment] = useState<EnrolmentState>({
    status: "idle",
  });
  const [starting, startTransition] = useTransition();

  if (mode === "verify") return <CodeForm />;

  if (enrolment.status === "enrolling") {
    return (
      <div className="flex flex-col gap-5">
        <p className="text-sm">
          Scan this QR code with an authenticator app, then enter the 6-digit
          code it shows.
        </p>
        {/* Supabase returns the QR as an SVG data URI */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={enrolment.qrCode}
          alt="Authenticator QR code"
          width={192}
          height={192}
          className="mx-auto"
        />
        <p className="text-muted-foreground text-xs break-all">
          Cannot scan? Enter this key manually:{" "}
          <code className="font-mono">{enrolment.secret}</code>
        </p>
        <CodeForm factorId={enrolment.factorId} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {enrolment.status === "error" ? (
        <Alert variant="destructive">{enrolment.message}</Alert>
      ) : null}
      <Button
        size="lg"
        disabled={starting}
        aria-busy={starting}
        onClick={() =>
          startTransition(async () =>
            setEnrolment(await startMfaEnrolmentAction()),
          )
        }
      >
        {starting ? "Preparing…" : "Set up authenticator"}
      </Button>
    </div>
  );
}
