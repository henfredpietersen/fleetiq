import type { ReactNode } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import type { ActionState } from "./action-state";

export function Field({
  id,
  label,
  hint,
  ...input
}: {
  id: string;
  label: string;
  hint?: string;
} & React.ComponentProps<"input">) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        name={id}
        aria-describedby={hint ? `${id}-hint` : undefined}
        {...input}
      />
      {hint ? (
        <p id={`${id}-hint`} className="text-muted-foreground text-xs">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function FormMessage({ state }: { state: ActionState }) {
  if (state.status === "error") {
    return (
      <Alert variant="destructive">
        <p>{state.message}</p>
        {state.details?.length ? (
          <ul className="mt-1 list-disc pl-5">
            {state.details.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
        ) : null}
      </Alert>
    );
  }
  if (state.status === "success" && state.message)
    return <Alert variant="success">{state.message}</Alert>;
  return null;
}

export function SubmitButton({
  pending,
  children,
  pendingLabel,
}: {
  pending: boolean;
  children: ReactNode;
  pendingLabel: string;
}) {
  return (
    <Button type="submit" size="lg" disabled={pending} aria-busy={pending}>
      {pending ? pendingLabel : children}
    </Button>
  );
}
