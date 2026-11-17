import Link from "next/link";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { statusLabel } from "../domain/format";

/** Desktop-first page frame for the management screens. */
export function PageShell({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-6 px-6 py-8">
      <nav aria-label="Vehicle register" className="flex items-center gap-6">
        <p className="text-muted-foreground text-sm font-medium tracking-wide">
          FleetIQ
        </p>
        <Link href="/vehicles" className="text-sm font-medium hover:underline">
          Vehicles
        </Link>
        <Link
          href="/vehicles/transfers"
          className="text-sm font-medium hover:underline"
        >
          Transfers
        </Link>
        <Link
          href="/service/verification"
          className="text-sm font-medium hover:underline"
        >
          Service
        </Link>
        <Link
          href="/home"
          className="text-muted-foreground ml-auto text-sm hover:underline"
        >
          Home
        </Link>
      </nav>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{title}</h1>
          {description ? (
            <p className="text-muted-foreground mt-1 text-sm">{description}</p>
          ) : null}
        </div>
        {actions}
      </header>
      {children}
    </main>
  );
}

export function Loading({ label }: { label: string }) {
  return (
    <p
      role="status"
      aria-live="polite"
      className="text-muted-foreground text-sm"
    >
      {label}
    </p>
  );
}

export function StatusBadge({
  status,
  archived,
}: {
  status: string;
  archived?: boolean;
}) {
  if (archived) return <Badge variant="outline">Archived</Badge>;
  const variant =
    status === "available"
      ? "success"
      : status === "in_maintenance"
        ? "warning"
        : status === "out_of_service"
          ? "destructive"
          : "default";
  return <Badge variant={variant}>{statusLabel(status)}</Badge>;
}
