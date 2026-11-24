import { Suspense } from "react";
import { connection } from "next/server";
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
  allocationStatusLabel,
  licenceCheckLabel,
} from "@/modules/shifts-allocations/domain/allocation-text";
import { boardFilterSchema } from "@/modules/shifts-allocations/domain/allocation-schema";
import {
  formatLocalClock,
  formatShiftDate,
  formatShiftWindow,
} from "@/modules/shifts-allocations/domain/format";
import { localDate } from "@/modules/shifts-allocations/domain/shift-times";
import {
  getAllocatable,
  getBoard,
} from "@/modules/shifts-allocations/server/allocation-queries";
import { getShiftAccess } from "@/modules/shifts-allocations/server/queries";
import {
  noShowAllowed,
  noShowFrom,
  startOpensAt,
  startWindowOpen,
} from "@/modules/shifts-allocations/domain/allocation-settings";
import { AllocateDialog } from "@/modules/shifts-allocations/ui/allocate-dialog";
import { AllocationRowActions } from "@/modules/shifts-allocations/ui/allocation-row-actions";
import { ShiftNav } from "@/modules/shifts-allocations/ui/shift-nav";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const first = (v: string | string[] | undefined) =>
  Array.isArray(v) ? v[0] : v;

async function Content({ searchParams }: { searchParams: SearchParams }) {
  await requireSession("full");
  await connection(); // the start window and no-show grace depend on the current time
  const now = new Date();
  const sp = await searchParams;
  const db = await createSupabaseServerClient();
  const access = await getShiftAccess(db);
  if (!access.ok)
    return (
      <Alert variant="destructive">
        The allocation board could not be loaded. Please refresh the page.
      </Alert>
    );
  const viewable = access.branches.filter((b) => b.canView);
  if (viewable.length === 0)
    return (
      <Alert>
        You do not have access to allocations. They are visible to people who
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

  // DEC-09: completing the post-shift inspection for the driver needs allocation.manage AND inspection.submit for the branch
  const { data: canSubmit } = branch.canManage
    ? await db.rpc("has_permission", {
        permission_key: "inspection.submit",
        target_branch_id: branch.id,
      })
    : { data: false };
  const [board, pick] = await Promise.all([
    getBoard(db, branch.id, date),
    branch.canManage ? getAllocatable(db, branch.id) : null,
  ]);
  if (!board.ok)
    return (
      <Alert variant="destructive">
        The allocation board could not be loaded. Please refresh the page.
      </Alert>
    );
  const scheduled = board.shifts.filter((s) => s.status === "scheduled");

  return (
    <>
      {!parsed.success ? (
        <Alert>
          That filter was not valid, so today at the first branch is shown.
        </Alert>
      ) : null}
      <div className="flex flex-wrap items-end gap-4">
        <form
          method="get"
          className="flex flex-wrap items-end gap-4"
          aria-label="Filter the allocation board"
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
        {branch.canManage && pick?.ok ? (
          <div className="ml-auto">
            <AllocateDialog
              shifts={scheduled.map((s) => ({
                id: s.id,
                label: `${formatShiftDate(s.shift_date)} · ${formatShiftWindow(s.scheduled_start_at, s.scheduled_end_at)}`,
              }))}
              vehicles={pick.vehicles}
              drivers={pick.drivers}
            />
          </div>
        ) : null}
      </div>
      {branch.canManage && pick && !pick.ok ? (
        <Alert variant="destructive">
          The vehicles and drivers to choose from could not be loaded, so
          allocating is unavailable. Please refresh the page.
        </Alert>
      ) : null}

      {board.shifts.length === 0 ? (
        <Card>
          <CardContent className="text-muted-foreground pt-6 text-sm">
            No shifts at {branch.name} on {formatShiftDate(date)}. Create or
            generate shifts first.
          </CardContent>
        </Card>
      ) : (
        board.shifts.map((s) => {
          const rows = board.allocations.filter((a) => a.shiftId === s.id);
          return (
            <Card key={s.id} data-testid="board-shift">
              <CardHeader>
                <CardTitle className="flex items-center gap-3">
                  {formatShiftWindow(s.scheduled_start_at, s.scheduled_end_at)}
                  {s.status === "cancelled" ? (
                    <Badge variant="destructive">Cancelled</Badge>
                  ) : null}
                </CardTitle>
                <CardDescription>
                  {branch.name}, {formatShiftDate(s.shift_date)}. Times are
                  Africa/Johannesburg.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {rows.length === 0 ? (
                  <p className="text-muted-foreground text-sm">
                    No allocations on this shift yet.
                  </p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Vehicle</TableHead>
                        <TableHead>Driver</TableHead>
                        <TableHead>Planned</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Licence</TableHead>
                        <TableHead>Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rows.map((a) => {
                        const lic = licenceCheckLabel(a.licenceClassCheck);
                        return (
                          <TableRow key={a.id} data-testid="allocation-row">
                            <TableCell>{a.vehicleLabel}</TableCell>
                            <TableCell>{a.driverLabel}</TableCell>
                            <TableCell className="tabular-nums">
                              {formatLocalClock(a.plannedStartAt)}–
                              {formatLocalClock(a.plannedEndAt)}
                            </TableCell>
                            <TableCell>
                              <Badge variant="outline">
                                {allocationStatusLabel(a.status)}
                              </Badge>
                            </TableCell>
                            <TableCell>
                              <Badge variant={lic.variant}>{lic.label}</Badge>
                            </TableCell>
                            <TableCell>
                              <AllocationRowActions
                                id={a.id}
                                label={`${a.vehicleLabel}, ${a.driverLabel}`}
                                status={a.status}
                                plannedStartAt={a.plannedStartAt}
                                plannedEndAt={a.plannedEndAt}
                                openedOnBehalf={a.openedOnBehalf}
                                canManage={branch.canManage}
                                canCompleteOnBehalf={
                                  branch.canManage && canSubmit === true
                                }
                                startWindowOpen={startWindowOpen(
                                  new Date(a.plannedStartAt),
                                  new Date(a.plannedEndAt),
                                  now,
                                )}
                                startOpensAtLabel={`${formatShiftDate(localDate(startOpensAt(new Date(a.plannedStartAt))))} ${formatLocalClock(startOpensAt(new Date(a.plannedStartAt)).toISOString())}`}
                                noShowOk={noShowAllowed(
                                  new Date(a.plannedStartAt),
                                  now,
                                )}
                                noShowFromLabel={formatLocalClock(
                                  noShowFrom(
                                    new Date(a.plannedStartAt),
                                  ).toISOString(),
                                )}
                              />
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          );
        })
      )}
      {!branch.canManage ? (
        <p className="text-muted-foreground text-sm">
          You can view allocations at this branch but not change them.
        </p>
      ) : null}
    </>
  );
}

export default function AllocationsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  return (
    <AppShell
      title="Allocations"
      description="Vehicles and drivers allocated to each shift. A driver may use more than one vehicle in a shift, one at a time."
    >
      <ShiftNav />
      <Suspense fallback={<Loading label="Loading the allocation board…" />}>
        <Content searchParams={searchParams} />
      </Suspense>
    </AppShell>
  );
}
