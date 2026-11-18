import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import { ShiftsNavLink } from "@/modules/shifts-allocations/ui/shifts-nav-link";

/** Desktop-first frame for the management screens (drivers, staff users). */
export function AppShell({
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
      <nav aria-label="Main" className="flex flex-wrap items-center gap-6">
        <p className="text-muted-foreground text-sm font-medium tracking-wide">
          FleetIQ
        </p>
        <Link href="/vehicles" className="text-sm font-medium hover:underline">
          Vehicles
        </Link>
        <Link href="/drivers" className="text-sm font-medium hover:underline">
          Drivers
        </Link>
        <Suspense fallback={null}>
          <ShiftsNavLink />
        </Suspense>
        <Link
          href="/service/verification"
          className="text-sm font-medium hover:underline"
        >
          Service
        </Link>
        <Link
          href="/admin/users"
          className="text-sm font-medium hover:underline"
        >
          Staff users
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
