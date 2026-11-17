import type { ReactNode } from "react";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

export {
  Field,
  FormMessage,
  SubmitButton,
} from "@/modules/identity-access/ui/form-parts";

export function SelectField({
  id,
  label,
  hint,
  children,
  ...select
}: {
  id: string;
  label: string;
  hint?: string;
  children: ReactNode;
} & React.ComponentProps<"select">) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Select
        id={id}
        name={id}
        aria-describedby={hint ? `${id}-hint` : undefined}
        {...select}
      >
        {children}
      </Select>
      {hint ? (
        <p id={`${id}-hint`} className="text-muted-foreground text-xs">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function TextareaField({
  id,
  label,
  ...area
}: { id: string; label: string } & React.ComponentProps<"textarea">) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Textarea id={id} name={id} {...area} />
    </div>
  );
}
