import Link from "next/link";
import { Suspense } from "react";
import { Alert } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
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
import {
  ADMIN_STATUSES,
  ADMIN_STATUS_LABELS,
  parseFilters,
} from "@/modules/fleet-vehicles/domain/vehicle-schema";
import {
  listBranches,
  listVehicles,
  manageableBranchIds,
} from "@/modules/fleet-vehicles/server/queries";
import {
  Loading,
  PageShell,
  StatusBadge,
} from "@/modules/fleet-vehicles/ui/page-shell";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

async function Content({ searchParams }: { searchParams: SearchParams }) {
  await requireSession("full");
  const filters = parseFilters(await searchParams);
  const db = await createSupabaseServerClient();
  const [branchRes, listRes] = await Promise.all([
    listBranches(db),
    listVehicles(db, filters),
  ]);

  if (!branchRes.ok || !listRes.ok) {
    return (
      <Alert variant="destructive">
        The vehicle register could not be loaded. Please refresh the page; if it
        keeps happening, contact an administrator.
      </Alert>
    );
  }
  const branches = branchRes.branches;
  const branchName = new Map(branches.map((b) => [b.id, b.name]));
  const canCreate = (await manageableBranchIds(db, branches)).size > 0;
  const vehicles = listRes.vehicles;
  const filtered =
    filters.q ||
    filters.branchId ||
    filters.status ||
    filters.archived !== "active";

  return (
    <>
      <form
        method="get"
        className="flex flex-wrap items-end gap-4"
        aria-label="Filter vehicles"
      >
        <div className="flex min-w-56 flex-col gap-2">
          <Label htmlFor="q">Search</Label>
          <Input
            id="q"
            name="q"
            defaultValue={filters.q ?? ""}
            placeholder="Registration, fleet no., make, model"
            maxLength={50}
          />
        </div>
        <div className="flex min-w-44 flex-col gap-2">
          <Label htmlFor="branch">Branch</Label>
          <Select
            id="branch"
            name="branch"
            defaultValue={filters.branchId ?? ""}
          >
            <option value="">All my branches</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex min-w-44 flex-col gap-2">
          <Label htmlFor="status">Status</Label>
          <Select id="status" name="status" defaultValue={filters.status ?? ""}>
            <option value="">Any status</option>
            {ADMIN_STATUSES.map((s) => (
              <option key={s} value={s}>
                {ADMIN_STATUS_LABELS[s]}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex min-w-40 flex-col gap-2">
          <Label htmlFor="archived">Show</Label>
          <Select id="archived" name="archived" defaultValue={filters.archived}>
            <option value="active">Active</option>
            <option value="archived">Archived</option>
            <option value="all">All</option>
          </Select>
        </div>
        <Button type="submit">Apply</Button>
        {filtered ? (
          <Link
            href="/vehicles"
            className={buttonVariants({ variant: "ghost" })}
          >
            Clear
          </Link>
        ) : null}
        {canCreate ? (
          <Link
            href="/vehicles/new"
            className={buttonVariants({ className: "ml-auto" })}
          >
            Add vehicle
          </Link>
        ) : null}
      </form>

      {vehicles.length === 0 ? (
        <Alert>
          {filtered
            ? "No vehicles match these filters."
            : "There are no vehicles in the branches you can see yet."}
          {!filtered && canCreate
            ? " Use “Add vehicle” to register the first one."
            : ""}
        </Alert>
      ) : (
        <>
          <p className="text-muted-foreground text-sm" aria-live="polite">
            {vehicles.length} vehicle{vehicles.length === 1 ? "" : "s"}
            {vehicles.length === 500
              ? " (showing the first 500; narrow the filters)"
              : ""}
          </p>
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Registration</TableHead>
                  <TableHead>Fleet no.</TableHead>
                  <TableHead>Vehicle</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Branch</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {vehicles.map((v) => (
                  <TableRow key={v.id}>
                    <TableCell className="font-medium">
                      <Link
                        href={`/vehicles/${v.id}`}
                        className="hover:underline"
                      >
                        {v.registration_number}
                      </Link>
                    </TableCell>
                    <TableCell>{v.fleet_number}</TableCell>
                    <TableCell>
                      {v.make} {v.model}
                    </TableCell>
                    <TableCell>{v.vehicle_category}</TableCell>
                    <TableCell>
                      {branchName.get(v.current_branch_id) ?? "—"}
                    </TableCell>
                    <TableCell>
                      <StatusBadge
                        status={v.administrative_status}
                        archived={v.archived_at !== null}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </>
  );
}

export default function VehiclesPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  return (
    <PageShell
      title="Vehicles"
      description="The vehicle register for the branches you have access to."
    >
      <Suspense fallback={<Loading label="Loading vehicles…" />}>
        <Content searchParams={searchParams} />
      </Suspense>
    </PageShell>
  );
}
