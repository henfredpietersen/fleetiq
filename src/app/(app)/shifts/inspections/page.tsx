import Link from "next/link";
import { Suspense } from "react";
import { connection } from "next/server";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { AppShell, Loading } from "@/components/app-shell";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireSession } from "@/modules/identity-access/server/session";
import { allocationStatusLabel } from "@/modules/shifts-allocations/domain/allocation-text";
import { boardFilterSchema } from "@/modules/shifts-allocations/domain/allocation-schema";
import {
  formatLocalClock,
  formatShiftDate,
} from "@/modules/shifts-allocations/domain/format";
import { localDate } from "@/modules/shifts-allocations/domain/shift-times";
import { getShiftAccess } from "@/modules/shifts-allocations/server/queries";
import { ShiftNav } from "@/modules/shifts-allocations/ui/shift-nav";
import {
  INSPECTION_STATUS_LABELS,
  stageLabel,
} from "@/modules/inspections-damage/domain/inspection-rules";
import { DEVICE_FLAG_LABEL } from "@/modules/drivers/domain/device-schema";
import { listInspections } from "@/modules/inspections-damage/server/inspection-service";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const first = (v: string | string[] | undefined) =>
  Array.isArray(v) ? v[0] : v;
// Africa/Johannesburg is UTC+2 all year (no DST): local midnight is `${date}T00:00:00+02:00`.
const dayStart = (d: string) => `${d}T00:00:00+02:00`;
const addDays = (d: string, n: number) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000)
    .toISOString()
    .slice(0, 10);

async function Content({ searchParams }: { searchParams: SearchParams }) {
  await requireSession("full");
  await connection();
  const sp = await searchParams;
  const db = await createSupabaseServerClient();
  const access = await getShiftAccess(db);
  if (!access.ok)
    return (
      <Alert variant="destructive">
        The inspections could not be loaded. Please refresh the page.
      </Alert>
    );
  const viewable = access.branches.filter((b) => b.canView);
  if (viewable.length === 0)
    return (
      <Alert>
        You do not have access to inspections. They are visible to people who
        manage allocations or view reports.
      </Alert>
    );
  const parsed = boardFilterSchema.safeParse({
    branchId: first(sp.branch),
    date: first(sp.date),
  });
  const f = parsed.success ? parsed.data : {};
  const branch = viewable.find((b) => b.id === f.branchId) ?? viewable[0];
  const date = f.date ?? localDate(new Date());
  const r = await listInspections(db, {
    from: dayStart(date),
    to: dayStart(addDays(date, 1)),
    branchId: branch.id,
  });
  if (!r.ok)
    return (
      <Alert variant="destructive">
        The inspections could not be loaded. {r.message}
      </Alert>
    );

  return (
    <>
      {!parsed.success ? (
        <Alert>
          That filter was not valid, so today at the first branch is shown.
        </Alert>
      ) : null}
      <form
        method="get"
        className="flex flex-wrap items-end gap-4"
        aria-label="Filter the inspections"
      >
        <div className="flex min-w-56 flex-col gap-2">
          <Label htmlFor="branch">Branch</Label>
          <Select id="branch" name="branch" defaultValue={branch.id}>
            {viewable.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="date">Date</Label>
          <Input id="date" name="date" type="date" defaultValue={date} />
        </div>
        <Button type="submit" variant="outline">
          Apply
        </Button>
      </form>
      {r.rows.length === 0 ? (
        <Alert>
          No inspections were started at {branch.name} on{" "}
          {formatShiftDate(date)}.
        </Alert>
      ) : (
        <Table aria-label="Inspections">
          <TableHeader>
            <TableRow>
              <TableHead>Started</TableHead>
              <TableHead>Vehicle</TableHead>
              <TableHead>Stage</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Flags</TableHead>
              <TableHead>Allocation</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {r.rows.map((i) => (
              <TableRow key={i.id} data-testid="inspection-row">
                <TableCell>{formatLocalClock(i.startedAt)}</TableCell>
                <TableCell>
                  <Link
                    href={`/shifts/inspections/${i.id}`}
                    className="font-medium hover:underline"
                  >
                    {i.fleetNumber} · {i.registration}
                  </Link>
                </TableCell>
                <TableCell>{stageLabel(i.stage)}</TableCell>
                <TableCell>
                  {INSPECTION_STATUS_LABELS[i.status] ?? i.status}
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {i.lateFlag ? <Badge variant="warning">Late</Badge> : null}
                    {i.safetyDefectFlag ? (
                      <Badge variant="destructive">Safety defect</Badge>
                    ) : null}
                    {i.capturedOffline ? (
                      <Badge variant="outline">Offline</Badge>
                    ) : null}
                    {i.deviceFlag && i.deviceFlag !== "issued_device" ? (
                      <Badge variant="warning">
                        {DEVICE_FLAG_LABEL[i.deviceFlag] ?? i.deviceFlag}
                      </Badge>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell>
                  {allocationStatusLabel(i.allocationStatus)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </>
  );
}

export default function InspectionsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  return (
    <AppShell
      title="Inspections"
      description="Pre- and post-shift inspections for the branches you manage or view reports for. Open one to see its answers and photos."
    >
      <ShiftNav />
      <Suspense fallback={<Loading label="Loading the inspections…" />}>
        <Content searchParams={searchParams} />
      </Suspense>
    </AppShell>
  );
}
