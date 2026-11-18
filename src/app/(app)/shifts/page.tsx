import { Suspense } from "react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import {
  formatClock,
  formatShiftDate,
  formatShiftWindow,
} from "@/modules/shifts-allocations/domain/format";
import { shiftFilterSchema } from "@/modules/shifts-allocations/domain/shift-schema";
import { localDate } from "@/modules/shifts-allocations/domain/shift-times";
import {
  defaultRange,
  getShiftAccess,
  listDepartments,
  listShifts,
  listTemplates,
} from "@/modules/shifts-allocations/server/queries";
import { GenerateShiftsDialog } from "@/modules/shifts-allocations/ui/generate-dialog";
import {
  AdHocShiftForm,
  CancelShiftForm,
} from "@/modules/shifts-allocations/ui/shift-forms";
import { ShiftNav } from "@/modules/shifts-allocations/ui/shift-nav";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const first = (v: string | string[] | undefined) =>
  Array.isArray(v) ? v[0] : v;

async function Content({ searchParams }: { searchParams: SearchParams }) {
  await requireSession("full");
  const sp = await searchParams;
  const db = await createSupabaseServerClient();
  const access = await getShiftAccess(db);
  if (!access.ok)
    return (
      <Alert variant="destructive">
        Shifts could not be loaded. Please refresh the page.
      </Alert>
    );
  const viewable = access.branches.filter((b) => b.canView);
  if (viewable.length === 0)
    return (
      <Alert>
        You do not have access to shifts. They are visible to people who manage
        allocations or view reports.
      </Alert>
    );

  const parsed = shiftFilterSchema.safeParse({
    branchId: first(sp.branch),
    from: first(sp.from),
    to: first(sp.to),
  });
  const dflt = defaultRange();
  const f = parsed.success ? parsed.data : {};
  const branch = viewable.find((b) => b.id === f.branchId) ?? viewable[0];
  const from = f.from ?? dflt.from;
  const to = f.to && f.to >= from ? f.to : f.from ? from : dflt.to;

  const [shiftsRes, templatesRes, deptRes] = await Promise.all([
    listShifts(db, { branchId: branch.id, from, to }),
    listTemplates(db, branch.id, false),
    listDepartments(db, branch.id),
  ]);
  if (!shiftsRes.ok)
    return (
      <Alert variant="destructive">
        The shifts could not be loaded. Please refresh the page.
      </Alert>
    );
  const templates = templatesRes.ok ? templatesRes.templates : [];
  const departments = deptRes.ok ? deptRes.departments : [];
  const templateName = new Map(templates.map((t) => [t.id, t.name]));
  const deptName = new Map(departments.map((d) => [d.id, d.name]));
  const shifts = shiftsRes.shifts;

  return (
    <>
      {!parsed.success ? (
        <Alert>
          That filter was not valid, so the default range is shown instead.
        </Alert>
      ) : null}
      <form
        method="get"
        className="flex flex-wrap items-end gap-4"
        aria-label="Filter shifts"
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
          <Label htmlFor="from">From</Label>
          <Input id="from" name="from" type="date" defaultValue={from} />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="to">To</Label>
          <Input id="to" name="to" type="date" defaultValue={to} />
        </div>
        <Button type="submit" variant="outline">
          Apply
        </Button>
        {branch.canManage ? (
          <div className="ml-auto">
            <GenerateShiftsDialog
              templates={templates.map((t) => ({
                id: t.id,
                label: `${t.name} (${formatClock(t.start_time)}–${formatClock(t.end_time)})`,
              }))}
              defaultFrom={from}
              defaultTo={to}
            />
          </div>
        ) : null}
      </form>

      <Card>
        <CardHeader>
          <CardTitle>
            Shifts at {branch.name}, {formatShiftDate(from)} –{" "}
            {formatShiftDate(to)}
          </CardTitle>
          <CardDescription>
            Times are Africa/Johannesburg. A shift is dated by its local start;
            an end after midnight shows “+1 day”.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {shifts.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No shifts in this range.
              {branch.canManage
                ? " Generate them from a template, or create an ad hoc shift below."
                : ""}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Time</TableHead>
                  <TableHead>Template</TableHead>
                  <TableHead>Department</TableHead>
                  <TableHead>Status</TableHead>
                  {branch.canManage ? <TableHead>Actions</TableHead> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {shifts.map((s) => (
                  <TableRow key={s.id} data-testid="shift-row">
                    <TableCell>{formatShiftDate(s.shift_date)}</TableCell>
                    <TableCell className="tabular-nums">
                      {formatShiftWindow(
                        s.scheduled_start_at,
                        s.scheduled_end_at,
                      )}
                    </TableCell>
                    <TableCell>
                      {s.shift_template_id
                        ? (templateName.get(s.shift_template_id) ?? "Template")
                        : "Ad hoc"}
                    </TableCell>
                    <TableCell>
                      {s.department_id
                        ? (deptName.get(s.department_id) ?? "Department")
                        : "—"}
                    </TableCell>
                    <TableCell>
                      {s.status === "cancelled" ? (
                        <div className="flex flex-col gap-1">
                          <Badge variant="destructive">Cancelled</Badge>
                          <span className="text-muted-foreground text-xs">
                            {s.cancel_reason}
                          </span>
                        </div>
                      ) : (
                        <Badge variant="success">Scheduled</Badge>
                      )}
                    </TableCell>
                    {branch.canManage ? (
                      <TableCell>
                        {s.status === "scheduled" ? (
                          <details>
                            <summary className="cursor-pointer text-sm underline">
                              Cancel…
                            </summary>
                            <div className="mt-3 max-w-sm">
                              <CancelShiftForm shiftId={s.id} />
                            </div>
                          </details>
                        ) : null}
                      </TableCell>
                    ) : null}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {branch.canManage ? (
        <Card>
          <CardHeader>
            <CardTitle>Create an ad hoc shift</CardTitle>
            <CardDescription>
              A one-off shift that is not generated from a template.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <AdHocShiftForm
              branchId={branch.id}
              departments={departments.map((d) => ({
                id: d.id,
                name: d.name,
              }))}
              defaultDate={localDate(new Date())}
            />
          </CardContent>
        </Card>
      ) : (
        <p className="text-muted-foreground text-sm">
          You can view shifts at this branch but not change them.
        </p>
      )}
    </>
  );
}

export default function ShiftsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  return (
    <AppShell
      title="Shifts"
      description="Scheduled shifts per branch. Managed by people who hold allocation.manage for the branch."
    >
      <ShiftNav />
      <Suspense fallback={<Loading label="Loading shifts…" />}>
        <Content searchParams={searchParams} />
      </Suspense>
    </AppShell>
  );
}
