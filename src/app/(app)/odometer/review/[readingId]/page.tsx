import Link from "next/link";
import { Suspense } from "react";
import { connection } from "next/server";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { AppShell, Loading } from "@/components/app-shell";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireSession } from "@/modules/identity-access/server/session";
import { stageLabel } from "@/modules/inspections-damage/domain/inspection-rules";
import {
  formatLocalClock,
  formatShiftDate,
} from "@/modules/shifts-allocations/domain/format";
import { localDate } from "@/modules/shifts-allocations/domain/shift-times";
import { isUuid } from "@/modules/evidence-storage/domain/validate";
import {
  checkLabel,
  RESULT_LABELS,
} from "@/modules/odometer-mileage/domain/review-types";
import { readingDetail } from "@/modules/odometer-mileage/server/review-service";
import { FullReviewDecision } from "@/modules/odometer-mileage/ui/full-review-decision";
import { ReadingPhoto } from "@/modules/odometer-mileage/ui/reading-photo";

const when = (iso: string) =>
  `${formatShiftDate(localDate(new Date(iso)))} ${formatLocalClock(iso)}`;

async function Content({ params }: { params: Promise<{ readingId: string }> }) {
  await requireSession("full");
  await connection();
  const { readingId } = await params;
  if (!isUuid(readingId))
    return <Alert variant="destructive">That reading was not found.</Alert>;
  const db = await createSupabaseServerClient();
  const r = await readingDetail(db, readingId);
  if (!r.ok)
    return (
      <Alert variant="destructive" role="alert">
        The reading could not be loaded. {r.message}
      </Alert>
    );
  const row = r.row;
  if (!row)
    return (
      <Alert data-testid="already-decided">
        This reading is no longer waiting for review ({r.detail.status}).{" "}
        <Link href="/odometer/review?tab=full" className="underline">
          Back to the list
        </Link>
      </Alert>
    );
  return (
    <div className="flex flex-col gap-6" data-testid="review-detail">
      <div className="grid gap-4 md:grid-cols-2">
        <ReadingPhoto
          evidenceFileId={row.evidenceFileId}
          readingId={row.readingId}
          label={`Odometer photo of ${row.registration}`}
        />
        <div className="flex flex-col gap-3">
          <div>
            <p className="text-muted-foreground text-sm">
              Typed by the driver (never edited)
            </p>
            <p
              className="text-5xl font-bold tracking-wider"
              data-testid="typed-reading"
              data-km={row.driverReadingKm ?? ""}
            >
              {row.driverReadingKm ?? "—"}{" "}
              <span className="text-2xl font-medium">km</span>
            </p>
          </div>
          <p className="font-medium">
            {row.fleetNumber} · {row.registration} · {stageLabel(row.stage)}
          </p>
          <p className="text-sm">
            Planned {when(row.plannedStartAt)} –{" "}
            {formatLocalClock(row.plannedEndAt)} · {row.branchName}
            {row.driverName ? ` · ${row.driverName}` : ""}
          </p>
          <p className="text-sm" data-testid="previous-reading">
            {row.previousAcceptedKm != null
              ? `Previous accepted reading of this vehicle: ${row.previousAcceptedKm} km${row.previousAcceptedAt ? ` (${when(row.previousAcceptedAt)})` : ""}`
              : "No earlier accepted reading of this vehicle."}
          </p>
          {row.fullReviewNote ? (
            <Alert role="status">
              Sent from the quick check: {row.fullReviewNote}
            </Alert>
          ) : null}
        </div>
      </div>

      <section aria-label="Checks" className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">Checks</h2>
        <ul className="flex flex-col gap-2" data-testid="checks">
          {row.checks.map((c) => (
            <li
              key={c.key}
              className="rounded-lg border p-3"
              data-check={c.key}
              data-result={c.result}
            >
              <p className="flex flex-wrap items-center gap-2 font-medium">
                {checkLabel(c.key)}
                <Badge variant={c.result === "fail" ? "warning" : "outline"}>
                  {RESULT_LABELS[c.result]}
                </Badge>
              </p>
              {c.note ? <p className="text-sm">{c.note}</p> : null}
              {Object.keys(c.values).length > 0 ? (
                <p className="text-muted-foreground text-xs">
                  {Object.entries(c.values)
                    .map(
                      ([k, v]) =>
                        `${k.replace(/_/g, " ")}: ${v === null ? "—" : String(v)}`,
                    )
                    .join(" · ")}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      <section aria-label="Open exceptions" className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">Exceptions</h2>
        {r.detail.exceptions.length === 0 ? (
          <p className="text-muted-foreground text-sm">None.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {r.detail.exceptions.map((e) => (
              <li key={e.id}>
                {checkLabel(e.type)} · {e.severity} · {e.status} —{" "}
                {e.description}
                {e.resolution_summary ? ` (${e.resolution_summary})` : ""}
              </li>
            ))}
          </ul>
        )}
      </section>

      <FullReviewDecision
        readingId={row.readingId}
        driverKm={row.driverReadingKm}
        canDecide={row.canDecide}
        blockedReason={row.blockedReason}
      />

      <section aria-label="History" className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">History</h2>
        <ul className="text-muted-foreground flex flex-col gap-1 text-sm">
          {r.detail.events.map((e, i) => (
            <li key={i}>
              {when(e.occurred_at)} · {e.type.replace(/_/g, " ")}
              {e.reason ? ` — ${e.reason}` : ""}
            </li>
          ))}
        </ul>
      </section>
      <Link
        href="/odometer/review?tab=full"
        className={buttonVariants({ variant: "outline", className: "w-fit" })}
      >
        Back to the full review list
      </Link>
    </div>
  );
}

export default function ReadingPage({
  params,
}: {
  params: Promise<{ readingId: string }>;
}) {
  return (
    <AppShell
      title="Review a reading"
      description="The photo, the typed value, every check and its values. Decide with a reason."
    >
      <Suspense fallback={<Loading label="Loading the reading…" />}>
        <Content params={params} />
      </Suspense>
    </AppShell>
  );
}
