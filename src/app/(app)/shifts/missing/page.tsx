import { Suspense } from "react";
import Link from "next/link";
import { connection } from "next/server";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import {
  formatLocalClock,
  formatShiftDate,
} from "@/modules/shifts-allocations/domain/format";
import { localDate } from "@/modules/shifts-allocations/domain/shift-times";
import { getShiftAccess } from "@/modules/shifts-allocations/server/queries";
import { ShiftNav } from "@/modules/shifts-allocations/ui/shift-nav";
import { stageLabel } from "@/modules/inspections-damage/domain/inspection-rules";
import { listOverdue } from "@/modules/inspections-damage/offline/server/conflict-service";
import { ResolveConflict } from "@/modules/inspections-damage/offline/ui/resolve-conflict";
import {
  reviewBranches,
  reviewCounts,
} from "@/modules/odometer-mileage/server/review-service";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const first = (v: string | string[] | undefined) =>
  Array.isArray(v) ? v[0] : v;
const when = (iso: string) =>
  `${formatShiftDate(localDate(new Date(iso)))} ${formatLocalClock(iso)}`;

// DEC-43: worked out on every read (the scheduled job records the same inspections once, for Phase 5 / Phase 8). NO driver names (DEC-41).
async function Content({ searchParams }: { searchParams: SearchParams }) {
  await requireSession("full");
  await connection();
  const sp = await searchParams;
  const db = await createSupabaseServerClient();
  const access = await getShiftAccess(db);
  if (!access.ok)
    return (
      <Alert variant="destructive">
        Missing and late inspections could not be loaded. Please refresh the
        page.
      </Alert>
    );
  const viewable = access.branches.filter((b) => b.canView);
  if (viewable.length === 0)
    return (
      <Alert>
        You do not have access to this page. It is visible to people who manage
        allocations or view reports.
      </Alert>
    );
  const branchF = viewable.find((b) => b.id === first(sp.branch));
  const stageRaw = first(sp.stage);
  const stageF =
    stageRaw === "pre_shift" || stageRaw === "post_shift" ? stageRaw : null;
  const loaded = await listOverdue(db, branchF?.id);
  if (!loaded.ok)
    return (
      <Alert variant="destructive">
        Missing and late inspections could not be loaded. {loaded.message}
      </Alert>
    );
  const overdue = loaded.rows.filter(
    (r) => r.kind === "overdue" && (!stageF || r.stage === stageF),
  );
  const conflicts = loaded.rows.filter((r) => r.kind === "sync_conflict");
  // 5A: the odometer readings waiting for a check, beside the missing / late list (shown to people who may review readings)
  const reviewable = await reviewBranches(db);
  const odo =
    reviewable.ok && reviewable.branches.length > 0
      ? await reviewCounts(db, branchF?.id)
      : null;
  return (
    <>
      {odo?.ok ? (
        <section
          aria-label="Odometer readings waiting"
          className="flex flex-wrap items-center gap-4 rounded-lg border p-4"
          data-testid="odometer-counts"
        >
          <p className="font-medium">Odometer readings waiting for a check:</p>
          <Link
            href="/odometer/review?tab=quick_check"
            className="underline"
            data-testid="count-quick"
          >
            Quick check ({odo.quickCheck})
          </Link>
          <Link
            href="/odometer/review?tab=full"
            className="underline"
            data-testid="count-full"
          >
            Full review ({odo.fullReview})
          </Link>
        </section>
      ) : null}
      <form
        method="get"
        className="flex flex-wrap items-end gap-4"
        aria-label="Filter missing and late inspections"
      >
        <div className="flex min-w-56 flex-col gap-2">
          <Label htmlFor="branch">Branch</Label>
          <Select id="branch" name="branch" defaultValue={branchF?.id ?? ""}>
            <option value="">All my branches</option>
            {viewable.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="stage">Stage</Label>
          <Select id="stage" name="stage" defaultValue={stageF ?? ""}>
            <option value="">Pre- and post-shift</option>
            <option value="pre_shift">Pre-shift</option>
            <option value="post_shift">Post-shift</option>
          </Select>
        </div>
        <Button type="submit" variant="outline">
          Apply
        </Button>
      </form>

      <section aria-label="Sync conflicts" className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">
          Sync conflicts ({conflicts.length})
        </h2>
        <p className="text-muted-foreground text-sm">
          Work saved on a driver&apos;s phone that the server refused. The
          driver keeps it on the phone until you resolve it here; resolve it
          only after you have decided what happens with it. Someone who reported
          it cannot resolve it themselves.
        </p>
        {conflicts.length === 0 ? (
          <Alert data-testid="no-conflicts">No open sync conflicts.</Alert>
        ) : (
          <ul className="flex flex-col gap-3">
            {conflicts.map((c) => (
              <li
                key={c.conflictId}
                data-testid="sync-conflict-row"
                className="flex flex-col gap-2 rounded-lg border p-4"
              >
                <p className="font-medium">
                  {c.fleetNumber} · {c.registration}
                  {c.stage ? ` · ${stageLabel(c.stage)}` : ""} · {c.branchName}
                </p>
                <p data-testid="conflict-message">{c.refusalMessage}</p>
                <p className="text-muted-foreground text-xs">
                  {c.functionName} · code {c.refusalCode} · reported{" "}
                  {c.reportedAt ? when(c.reportedAt) : ""} · allocation{" "}
                  {allocationStatusLabel(c.allocationStatus)}
                  {c.capturedOffline ? " · captured offline" : ""}
                </p>
                <ResolveConflict conflictId={c.conflictId!} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section
        aria-label="Missing and late inspections"
        className="flex flex-col gap-3"
      >
        <h2 className="text-lg font-semibold">
          Missing / late inspections ({overdue.length})
        </h2>
        {overdue.length === 0 ? (
          <Alert data-testid="nothing-overdue">
            Nothing is missing or late right now.
          </Alert>
        ) : (
          <Table aria-label="Missing and late inspections">
            <TableHeader>
              <TableRow>
                <TableHead>Vehicle</TableHead>
                <TableHead>Stage</TableHead>
                <TableHead>Planned</TableHead>
                <TableHead>Overdue by</TableHead>
                <TableHead>Allocation</TableHead>
                <TableHead>Branch</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {overdue.map((r) => (
                <TableRow
                  key={`${r.allocationId}:${r.stage}`}
                  data-testid="overdue-row"
                >
                  <TableCell className="font-medium">
                    {r.fleetNumber} · {r.registration}
                  </TableCell>
                  <TableCell>{r.stage ? stageLabel(r.stage) : ""}</TableCell>
                  <TableCell>{r.plannedAt ? when(r.plannedAt) : ""}</TableCell>
                  <TableCell>
                    <Badge variant="warning">{r.minutesOverdue} min</Badge>{" "}
                    {r.capturedOffline ? (
                      <Badge variant="outline">Captured offline</Badge>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    {allocationStatusLabel(r.allocationStatus)}
                  </TableCell>
                  <TableCell>{r.branchName}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
    </>
  );
}

export default function MissingLatePage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  return (
    <AppShell
      title="Missing / late inspections"
      description="Inspections not submitted within the late window (30 min after the planned start, 60 min after the planned end), and work the server refused from a phone. Live: worked out every time you open this page."
    >
      <ShiftNav />
      <Suspense
        fallback={<Loading label="Loading missing and late inspections…" />}
      >
        <Content searchParams={searchParams} />
      </Suspense>
    </AppShell>
  );
}
