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
  hasPermission,
  listVehicleOptions,
} from "@/modules/service-monitoring/server/queries";
import { RecordServiceForm } from "@/modules/service-monitoring/ui/record-forms";
import { ServiceNav } from "@/modules/service-monitoring/ui/service-nav";

async function Content() {
  await requireSession("full");
  const db = await createSupabaseServerClient();
  const res = await listVehicleOptions(db);
  if (!res.ok)
    return (
      <Alert variant="destructive">
        The vehicles could not be loaded. Please refresh the page.
      </Alert>
    );
  const branches = [...new Set(res.vehicles.map((v) => v.branchId))];
  const allowed = new Set(
    (
      await Promise.all(
        branches.map(async (b) =>
          (await hasPermission(db, "service.record.create", b)) ? b : null,
        ),
      )
    ).filter((b): b is string => b !== null),
  );
  const vehicles = res.vehicles.filter((v) => allowed.has(v.branchId));
  return (
    <Card>
      <CardHeader>
        <CardTitle>Service record</CardTitle>
        <CardDescription>
          The record starts as “recorded”. It only becomes a baseline when a
          different person verifies it against the evidence (DEC-24).
        </CardDescription>
      </CardHeader>
      <CardContent>
        {vehicles.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            You cannot record services for any vehicle you can see. This needs
            the maintenance administrator or fleet administrator role.
          </p>
        ) : (
          <RecordServiceForm
            vehicles={vehicles.map((v) => ({
              id: v.id,
              label: v.label,
              branchId: v.branchId,
            }))}
          />
        )}
      </CardContent>
    </Card>
  );
}

export default function NewServiceRecordPage() {
  return (
    <AppShell
      title="Record a service"
      description="Capture a service with its invoice, job card or service-book photo."
    >
      <ServiceNav />
      <Suspense fallback={<Loading label="Loading…" />}>
        <Content />
      </Suspense>
    </AppShell>
  );
}
