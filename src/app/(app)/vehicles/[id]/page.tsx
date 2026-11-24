import { randomUUID } from "node:crypto";
import Link from "next/link";
import { Suspense } from "react";
import { Alert } from "@/components/ui/alert";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireSession } from "@/modules/identity-access/server/session";
import { formatDateTime } from "@/modules/fleet-vehicles/domain/format";
import { uuidField } from "@/modules/fleet-vehicles/domain/vehicle-schema";
import {
  getVehicle,
  listBranches,
  manageableBranchIds,
} from "@/modules/fleet-vehicles/server/queries";
import {
  Loading,
  PageShell,
  StatusBadge,
} from "@/modules/fleet-vehicles/ui/page-shell";
import {
  ArchiveForm,
  RequestTransferForm,
} from "@/modules/fleet-vehicles/ui/transfer-forms";
import { VehicleForm } from "@/modules/fleet-vehicles/ui/vehicle-form";
import {
  getVehicleServiceStatus,
  hasPermission,
} from "@/modules/service-monitoring/server/queries";
import { BaselinePanel } from "@/modules/service-monitoring/ui/baseline-panel";
import {
  LicenceCodeGuidance,
  RequiredLicenceCodeForm,
} from "@/modules/shifts-allocations/ui/licence-code-form";

type Params = Promise<{ id: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

async function Content({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  const ctx = await requireSession("full");
  const { id } = await params;
  const created = (await searchParams).created === "1";
  if (!uuidField.safeParse(id).success) return <NotFound />;

  const db = await createSupabaseServerClient();
  const [res, branchRes, serviceStatus] = await Promise.all([
    getVehicle(db, id),
    listBranches(db),
    getVehicleServiceStatus(db, id),
  ]);
  if (!res.ok) {
    return res.reason === "not_found" ? (
      <NotFound />
    ) : (
      <Alert variant="destructive">
        This vehicle could not be loaded. Please refresh the page.
      </Alert>
    );
  }
  const { vehicle, history, pendingTransfer } = res;
  const branches = branchRes.ok ? branchRes.branches : [];
  const branchName = new Map(branches.map((b) => [b.id, b.name]));
  const manageable = await manageableBranchIds(db, branches);
  const canManage = manageable.has(vehicle.current_branch_id);
  const archived = vehicle.archived_at !== null;
  const destinations = branches.filter(
    (b) => manageable.has(b.id) && b.id !== vehicle.current_branch_id,
  );
  const submissionId = randomUUID();
  // The required licence code is a property of the vehicle: company-wide vehicle.manage (the SQL function re-checks).
  const canSetLicenceCode = await hasPermission(db, "vehicle.manage", null);
  const canRecordService = await hasPermission(
    db,
    "service.record.create",
    vehicle.current_branch_id,
  );

  return (
    <>
      {created ? (
        <Alert variant="success">
          Vehicle created with its first branch assignment.
        </Alert>
      ) : null}
      {archived ? (
        <Alert>
          This vehicle is archived. It is kept for history and cannot be edited
          or transferred until it is restored.
        </Alert>
      ) : null}

      <Link
        href={`/vehicles/${vehicle.id}/damage`}
        className="w-fit text-sm underline"
        data-testid="damage-register-link"
      >
        Damage register
      </Link>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-3">
            {vehicle.registration_number}
            <StatusBadge
              status={vehicle.administrative_status}
              archived={archived}
            />
          </CardTitle>
          <CardDescription>
            Branch: {branchName.get(vehicle.current_branch_id) ?? "—"} ·
            Odometer (derived from accepted readings):{" "}
            {vehicle.current_odometer_km.toLocaleString("en-ZA")} km
          </CardDescription>
        </CardHeader>
        <CardContent>
          {canManage ? null : (
            <p className="text-muted-foreground mb-4 text-sm">
              You can view this vehicle but not change it. Changes need the
              fleet administrator role.
            </p>
          )}
          <VehicleForm
            mode="edit"
            defaults={vehicle}
            readOnly={!canManage || archived}
          />
        </CardContent>
      </Card>

      <BaselinePanel
        status={serviceStatus.ok ? serviceStatus.status : null}
        failed={!serviceStatus.ok}
        canRecord={canRecordService}
      />

      <Card>
        <CardHeader>
          <CardTitle>Required licence code</CardTitle>
          <CardDescription>
            Currently:{" "}
            {vehicle.required_licence_code ??
              "not configured (the licence class is not checked when allocating)"}
            . Drivers need a verified licence of this class (or a class that
            covers it) for the shift.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <LicenceCodeGuidance />
          {canSetLicenceCode && !archived ? (
            <RequiredLicenceCodeForm
              vehicleId={vehicle.id}
              current={vehicle.required_licence_code}
            />
          ) : (
            <p className="text-muted-foreground text-sm">
              Only a fleet administrator can change this.
            </p>
          )}
        </CardContent>
      </Card>

      {canManage ? (
        <Card>
          <CardHeader>
            <CardTitle>{archived ? "Restore" : "Archive"}</CardTitle>
            <CardDescription>
              Vehicles are never deleted; archiving hides them from the default
              list and keeps all history.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ArchiveForm vehicleId={vehicle.id} archived={archived} />
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Branch transfer</CardTitle>
          <CardDescription>
            A transfer only takes effect once a different fleet administrator
            approves it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {pendingTransfer ? (
            <Alert>
              A transfer request is waiting for approval
              {pendingTransfer.requested_by === ctx.userId
                ? " (requested by you)"
                : ""}
              .{" "}
              <Link href="/vehicles/transfers" className="underline">
                View pending transfers
              </Link>
            </Alert>
          ) : archived ? (
            <p className="text-muted-foreground text-sm">
              Restore the vehicle to request a transfer.
            </p>
          ) : !canManage ? (
            <p className="text-muted-foreground text-sm">
              Only a fleet administrator can request a transfer.
            </p>
          ) : destinations.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              There is no other branch you can transfer this vehicle to.
            </p>
          ) : (
            <div className="max-w-xl">
              <RequestTransferForm
                vehicleId={vehicle.id}
                destinations={destinations}
                submissionId={submissionId}
              />
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Branch history</CardTitle>
          <CardDescription>
            Every assignment is kept; history is never edited.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {res.historyFailed ? (
            <Alert variant="destructive">
              The branch history could not be loaded.
            </Alert>
          ) : history.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No assignments are visible to you.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Branch</TableHead>
                  <TableHead>From</TableHead>
                  <TableHead>To</TableHead>
                  <TableHead>Basis</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {history.map((h) => (
                  <TableRow key={h.id}>
                    <TableCell>{branchName.get(h.branch_id) ?? "—"}</TableCell>
                    <TableCell>{formatDateTime(h.effective_from)}</TableCell>
                    <TableCell>
                      {h.effective_to
                        ? formatDateTime(h.effective_to)
                        : "Current"}
                    </TableCell>
                    <TableCell>
                      {h.approval_id
                        ? "Approved transfer"
                        : "Initial assignment"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </>
  );
}

function NotFound() {
  return (
    <Alert>
      This vehicle was not found, or it is not in a branch you have access to.{" "}
      <Link href="/vehicles" className="underline">
        Back to vehicles
      </Link>
    </Alert>
  );
}

export default function VehiclePage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  return (
    <PageShell title="Vehicle">
      <Suspense fallback={<Loading label="Loading vehicle…" />}>
        <Content params={params} searchParams={searchParams} />
      </Suspense>
    </PageShell>
  );
}
