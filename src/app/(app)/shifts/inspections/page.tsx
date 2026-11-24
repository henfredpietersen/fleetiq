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
const DEVICE_FILTERS = [
  "issued_device",
  "other_device",
  "unknown_device",
  "no_issued_device",
] as const;
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
  const loaded = await listInspections(db, {
    from: dayStart(date),
    to: dayStart(addDays(date, 1)),
    branchId: branch.id,
  });
  if (!loaded.ok)
    return (
      <Alert variant="destructive">
        The inspections could not be loaded. {loaded.message}
      </Alert>
    );
  // filters (all optional, combined with AND); an unknown value is ignored
  const on = (k: string) => first(sp[k]) === "1";
  const deviceF = DEVICE_FILTERS.find((d) => d === first(sp.device));
  const rows = loaded.rows.filter(
    (i) =>
      (!on("late") || i.lateFlag) &&
      (!on("safety") || i.safetyDefectFlag) &&
      (!on("newdamage") || i.newDamageFlag) &&
      (!on("onbehalf") || i.completedByRole === "supervisor_on_behalf") &&
      (!deviceF || i.deviceFlag === deviceF),
  );
  const filtered =
    on("late") ||
    on("safety") ||
    on("newdamage") ||
    on("onbehalf") ||
    !!deviceF;
  const r = { rows };

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
        <fieldset className="flex flex-wrap items-end gap-4">
          <legend className="sr-only">Show only</legend>
          {(
            [
              ["late", "Late"],
              ["safety", "Safety defect"],
              ["newdamage", "New damage"],
              ["onbehalf", "Completed by supervisor"],
            ] as const
          ).map(([k, label]) => (
            <label key={k} className="flex min-h-10 items-center gap-2 text-sm">
              <input
                type="checkbox"
                name={k}
                value="1"
                defaultChecked={on(k)}
              />
              {label}
            </label>
          ))}
          <div className="flex flex-col gap-2">
            <Label htmlFor="device">Device flag</Label>
            <Select id="device" name="device" defaultValue={deviceF ?? ""}>
              <option value="">Any</option>
              {DEVICE_FILTERS.map((d) => (
                <option key={d} value={d}>
                  {DEVICE_FLAG_LABEL[d] ?? d}
                </option>
              ))}
            </Select>
          </div>
        </fieldset>
        <Button type="submit" variant="outline">
          Apply
        </Button>
      </form>
      {r.rows.length === 0 ? (
        <Alert>
          {filtered
            ? `No inspections at ${branch.name} on ${formatShiftDate(date)} match those filters.`
            : `No inspections were started at ${branch.name} on ${formatShiftDate(date)}.`}
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
                    {i.newDamageFlag ? (
                      <Badge variant="warning">New damage</Badge>
                    ) : null}
                    {i.completedByRole === "supervisor_on_behalf" ? (
                      <Badge variant="outline">Completed by supervisor</Badge>
                    ) : null}
                    {i.completedByRole !== "supervisor_on_behalf" &&
                    i.deviceFlag &&
                    i.deviceFlag !== "issued_device" ? (
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
