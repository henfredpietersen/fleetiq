import { Suspense } from "react";
import { Alert } from "@/components/ui/alert";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { AppShell, Loading } from "@/components/app-shell";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireSession } from "@/modules/identity-access/server/session";
import {
  formatLocalClock,
  formatShiftDate,
} from "@/modules/shifts-allocations/domain/format";
import { listPendingOverrides } from "@/modules/shifts-allocations/server/allocation-queries";
import { DecideOverrideForm } from "@/modules/shifts-allocations/ui/override-forms";
import { ShiftNav } from "@/modules/shifts-allocations/ui/shift-nav";

async function Content() {
  const ctx = await requireSession("full");
  const db = await createSupabaseServerClient();
  const res = await listPendingOverrides(db);
  if (!res.ok)
    return (
      <Alert variant="destructive">
        The pending licence overrides could not be loaded. Please refresh the
        page.
      </Alert>
    );
  if (res.overrides.length === 0)
    return (
      <Card>
        <CardContent className="text-muted-foreground pt-6 text-sm">
          No licence overrides are waiting for approval.
        </CardContent>
      </Card>
    );
  return (
    <>
      {res.overrides.map((o) => {
        const [date, start] = o.shiftLabel.split("|");
        const isRequester = o.requestedBy === ctx.userId;
        const isDriver = o.driverProfileId === ctx.userId;
        return (
          <Card key={o.id} data-testid="override-card">
            <CardHeader>
              <CardTitle>
                {o.vehicleLabel} · {o.driverLabel}
              </CardTitle>
              <CardDescription>
                {date
                  ? `${formatShiftDate(date)}, from ${formatLocalClock(start)}. `
                  : ""}
                Requested by {o.requesterName}. The driver&apos;s licence is
                valid but its class does not cover this vehicle.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <p className="text-sm">
                <span className="font-medium">Reason: </span>
                {o.reason}
              </p>
              {isRequester ? (
                <p className="text-muted-foreground text-xs">
                  You requested this, so another manager must decide it.
                </p>
              ) : null}
              {isDriver ? (
                <p className="text-muted-foreground text-xs">
                  You are the driver on this allocation, so you cannot approve
                  it.
                </p>
              ) : null}
              <DecideOverrideForm
                approvalId={o.id}
                canApprove={!isRequester && !isDriver}
                canReject={!isRequester}
              />
            </CardContent>
          </Card>
        );
      })}
    </>
  );
}

export default function OverridesPage() {
  return (
    <AppShell
      title="Licence overrides"
      description="Allocations where the driver's licence class does not cover the vehicle. Another manager with allocation.manage for the branch must approve; the requester and the driver cannot."
    >
      <ShiftNav />
      <Suspense fallback={<Loading label="Loading licence overrides…" />}>
        <Content />
      </Suspense>
    </AppShell>
  );
}
