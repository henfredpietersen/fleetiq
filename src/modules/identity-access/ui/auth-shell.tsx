import type { ReactNode } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export function AuthShell({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center gap-6 px-4 py-8">
      <p className="text-muted-foreground text-center text-sm font-medium tracking-wide">
        FleetIQ
      </p>
      <Card>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          {description ? (
            <CardDescription>{description}</CardDescription>
          ) : null}
        </CardHeader>
        <CardContent className="flex flex-col gap-5">{children}</CardContent>
      </Card>
    </main>
  );
}

/** Loading state shown while the (dynamic) session check streams in. */
export function AuthLoading() {
  return (
    <p
      role="status"
      aria-live="polite"
      className="text-muted-foreground text-sm"
    >
      Loading…
    </p>
  );
}
