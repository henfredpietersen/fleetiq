import { Suspense } from "react";
import { connection } from "next/server";
import Link from "next/link";
import { Alert } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import {
  AuthLoading,
  AuthShell,
} from "@/modules/identity-access/ui/auth-shell";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireSession } from "@/modules/identity-access/server/session";
import { formatShiftDate } from "@/modules/shifts-allocations/domain/format";
import { localDate } from "@/modules/shifts-allocations/domain/shift-times";
import { listMyAllocations } from "@/modules/shifts-allocations/server/lifecycle-service";
import { MyAllocationCard } from "@/modules/shifts-allocations/ui/my-allocation-card";

// Africa/Johannesburg is UTC+2 all year (no DST): local midnight is `${date}T00:00:00+02:00`.
const dayStart = (d: string) => `${d}T00:00:00+02:00`;
const addDays = (d: string, n: number) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000)
    .toISOString()
    .slice(0, 10);

async function Content() {
  await requireSession("full");
  await connection();
  const db = await createSupabaseServerClient();
  const today = localDate(new Date());
  // today and the next 7 days = 8 local days (the function allows at most 14)
  const r = await listMyAllocations(db, {
    from: dayStart(today),
    to: dayStart(addDays(today, 8)),
  });
  if (!r.ok)
    return (
      <div className="flex flex-col gap-3">
        <Alert variant="destructive">
          Your allocations could not be loaded. {r.message}
        </Alert>
        <Link
          href="/my-allocations"
          className={buttonVariants({
            size: "lg",
            className: "min-h-14 w-full",
          })}
        >
          Try again
        </Link>
      </div>
    );
  if (r.allocations.length === 0)
    return (
      <Alert>
        You have no allocations today or in the next 7 days. Your supervisor
        allocates vehicles to you.
      </Alert>
    );
  // group by the local date of the planned start
  const groups = new Map<string, typeof r.allocations>();
  for (const a of r.allocations) {
    const d = localDate(a.plannedStartAt);
    groups.set(d, [...(groups.get(d) ?? []), a]);
  }
  return (
    <div className="flex flex-col gap-6">
      {[...groups.entries()].map(([d, list]) => (
        <section key={d} aria-label={formatShiftDate(d)}>
          <h2 className="mb-2 text-base font-semibold">
            {d === today ? "Today" : formatShiftDate(d)}
          </h2>
          <ul className="flex flex-col gap-3">
            {list.map((a) => (
              <MyAllocationCard key={a.id} a={a} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

export default function MyAllocationsPage() {
  return (
    <AuthShell
      title="My allocations"
      description="Your vehicles for today and the next 7 days."
    >
      <Suspense fallback={<AuthLoading />}>
        <Content />
      </Suspense>
      <Link
        href="/home"
        className={buttonVariants({
          variant: "outline",
          size: "lg",
          className: "min-h-12 w-full",
        })}
      >
        Back
      </Link>
    </AuthShell>
  );
}
