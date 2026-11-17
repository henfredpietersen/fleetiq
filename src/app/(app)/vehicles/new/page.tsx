import { Suspense } from "react";
import { Alert } from "@/components/ui/alert";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireSession } from "@/modules/identity-access/server/session";
import {
  listBranches,
  manageableBranchIds,
} from "@/modules/fleet-vehicles/server/queries";
import { Loading, PageShell } from "@/modules/fleet-vehicles/ui/page-shell";
import { VehicleForm } from "@/modules/fleet-vehicles/ui/vehicle-form";

async function Content() {
  await requireSession("full");
  const db = await createSupabaseServerClient();
  const res = await listBranches(db);
  if (!res.ok) {
    return (
      <Alert variant="destructive">
        Branches could not be loaded. Please refresh the page.
      </Alert>
    );
  }
  const allowed = await manageableBranchIds(db, res.branches);
  const branches = res.branches.filter((b) => allowed.has(b.id));
  if (branches.length === 0) {
    return (
      <Alert>
        You do not have permission to add vehicles. This needs the fleet
        administrator role (vehicle.manage).
      </Alert>
    );
  }
  return (
    <div className="max-w-3xl">
      <VehicleForm mode="create" branches={branches} />
    </div>
  );
}

export default function NewVehiclePage() {
  return (
    <PageShell
      title="Add vehicle"
      description="Creates the vehicle and its first branch assignment."
    >
      <Suspense fallback={<Loading label="Loading…" />}>
        <Content />
      </Suspense>
    </PageShell>
  );
}
