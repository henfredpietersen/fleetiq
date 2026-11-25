import Link from "next/link";
import { Suspense } from "react";
import { connection } from "next/server";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { AppShell, Loading } from "@/components/app-shell";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireSession } from "@/modules/identity-access/server/session";
import { stageLabel } from "@/modules/inspections-damage/domain/inspection-rules";
import {
  formatLocalClock,
  formatShiftDate,
} from "@/modules/shifts-allocations/domain/format";
import { localDate } from "@/modules/shifts-allocations/domain/shift-times";
import { ShiftNav } from "@/modules/shifts-allocations/ui/shift-nav";
import { checkLabel } from "@/modules/odometer-mileage/domain/review-types";
import {
  listReview,
  reviewBranches,
  reviewCounts,
} from "@/modules/odometer-mileage/server/review-service";
import { QuickCheckList } from "@/modules/odometer-mileage/ui/quick-check";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const first = (v: string | string[] | undefined) =>
  Array.isArray(v) ? v[0] : v;
const when = (iso: string) =>
  `${formatShiftDate(localDate(new Date(iso)))} ${formatLocalClock(iso)}`;

// DEC-44: the quick photo check (no failed check) and the full review (a failed check, or sent from the quick check). The lists come from
// SQL functions that authorise per branch and hide driver names from anyone who may not see the driver register (DEC-41).
async function Content({ searchParams }: { searchParams: SearchParams }) {
  await requireSession("full");
  await connection();
  const sp = await searchParams;
  const db = await createSupabaseServerClient();
  const branches = await reviewBranches(db);
  if (!branches.ok)
    return (
      <Alert variant="destructive">
        The odometer review could not be loaded. Please refresh the page.
      </Alert>
    );
  if (branches.branches.length === 0)
    return (
      <Alert>
        You do not have access to the odometer review. It is for people who
        check odometer readings for a branch.
      </Alert>
    );
  const branch = branches.branches.find((b) => b.id === first(sp.branch));
  const tab = first(sp.tab) === "full" ? "full" : "quick_check";
  const [counts, list] = await Promise.all([
    reviewCounts(db, branch?.id),
    listReview(db, tab, branch?.id),
  ]);
  const qs = (t: string) =>
    `/odometer/review?tab=${t}${branch ? `&branch=${branch.id}` : ""}`;
  return (
    <>
      <form
        method="get"
        className="flex flex-wrap items-end gap-4"
        aria-label="Filter the odometer review"
      >
        <input type="hidden" name="tab" value={tab} />
        <div className="flex min-w-56 flex-col gap-2">
          <Label htmlFor="branch">Branch</Label>
          <Select id="branch" name="branch" defaultValue={branch?.id ?? ""}>
            <option value="">All my branches</option>
            {branches.branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
        </div>
        <Button type="submit" variant="outline">
          Apply
        </Button>
      </form>

      <nav aria-label="Review queues" className="flex gap-2 border-b pb-3">
        <Link
          href={qs("quick_check")}
          aria-current={tab === "quick_check" ? "page" : undefined}
          className={buttonVariants({
            variant: tab === "quick_check" ? "default" : "outline",
            className: "min-h-11",
          })}
          data-testid="tab-quick"
        >
          Quick check{counts.ok ? ` (${counts.quickCheck})` : ""}
        </Link>
        <Link
          href={qs("full")}
          aria-current={tab === "full" ? "page" : undefined}
          className={buttonVariants({
            variant: tab === "full" ? "default" : "outline",
            className: "min-h-11",
          })}
          data-testid="tab-full"
        >
          Full review{counts.ok ? ` (${counts.fullReview})` : ""}
        </Link>
      </nav>

      {!list.ok ? (
        <Alert variant="destructive" role="alert">
          The readings could not be loaded. {list.message}
        </Alert>
      ) : list.rows.length === 0 ? (
        <Alert data-testid="review-empty">
          {tab === "quick_check"
            ? "Nothing is waiting for a quick photo check."
            : "Nothing is waiting for a full review."}
        </Alert>
      ) : tab === "quick_check" ? (
        <QuickCheckList rows={list.rows} />
      ) : (
        <ul className="flex flex-col gap-3" data-testid="full-review-list">
          {list.rows.map((r) => (
            <li
              key={r.readingId}
              data-testid="full-review-row"
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4"
            >
              <div className="flex flex-col gap-1">
                <p className="font-medium">
                  {r.fleetNumber} · {r.registration} · {stageLabel(r.stage)}
                </p>
                <p className="text-sm">
                  Typed reading: <strong>{r.driverReadingKm ?? "—"} km</strong>{" "}
                  · planned {when(r.plannedStartAt)} · {r.branchName}
                  {r.driverName ? ` · ${r.driverName}` : ""}
                </p>
                <p className="flex flex-wrap gap-2 text-sm">
                  {r.failedChecks.length > 0 ? (
                    r.failedChecks.map((k) => (
                      <Badge key={k} variant="warning">
                        {checkLabel(k)}
                      </Badge>
                    ))
                  ) : (
                    <Badge variant="outline">Sent from the quick check</Badge>
                  )}
                </p>
                {r.fullReviewNote ? (
                  <p className="text-muted-foreground text-sm">
                    Note: {r.fullReviewNote}
                  </p>
                ) : null}
              </div>
              <Link
                href={`/odometer/review/${r.readingId}`}
                className={buttonVariants({ className: "min-h-11" })}
              >
                Review
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export default function OdometerReviewPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  return (
    <AppShell
      title="Odometer review"
      description="Check each typed reading against its photo. Readings without a failed check go to the quick check; the others need a full review. Nobody checks a reading they entered, completed or drove."
    >
      <ShiftNav />
      <Suspense fallback={<Loading label="Loading the odometer review…" />}>
        <Content searchParams={searchParams} />
      </Suspense>
    </AppShell>
  );
}
