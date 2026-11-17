import Link from "next/link";
import { Suspense } from "react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { AppShell, Loading } from "@/components/app-shell";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { formatDateTime } from "@/modules/fleet-vehicles/domain/format";
import { requireSession } from "@/modules/identity-access/server/session";
import {
  formatDate,
  formatKm,
} from "@/modules/service-monitoring/domain/format";
import { listRecords } from "@/modules/service-monitoring/server/queries";
import {
  ReverseVerificationForm,
  VerifyRecordForm,
  ViewEvidenceButton,
} from "@/modules/service-monitoring/ui/record-forms";
import { ServiceNav } from "@/modules/service-monitoring/ui/service-nav";

type Rec = Extract<
  Awaited<ReturnType<typeof listRecords>>,
  { ok: true }
>["records"][number];

function Summary({ r }: { r: Rec }) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <Link
          href={`/vehicles/${r.vehicle_id}`}
          className="font-medium hover:underline"
        >
          {r.vehicleLabel}
        </Link>
        {r.source === "historical_import" ? (
          <Badge variant="outline">Baseline import</Badge>
        ) : null}
        <span className="text-sm">
          {formatDate(r.service_date)} ·{" "}
          {formatKm(r.actual_service_odometer_km)} · {r.service_type}
        </span>
      </div>
      <p className="text-muted-foreground text-xs">
        {[
          r.supplier_name,
          r.job_reference && `Job ${r.job_reference}`,
          r.invoice_reference && `Invoice ${r.invoice_reference}`,
        ]
          .filter(Boolean)
          .join(" · ") || "No workshop details"}
        {" · "}recorded {formatDateTime(r.created_at)}
      </p>
    </>
  );
}

async function Content() {
  const ctx = await requireSession("full");
  const db = await createSupabaseServerClient();
  const [queue, verified] = await Promise.all([
    listRecords(db, "recorded"),
    listRecords(db, "verified", 20),
  ]);
  if (!queue.ok)
    return (
      <Alert variant="destructive">
        The verification queue could not be loaded. Please refresh the page.
      </Alert>
    );
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Awaiting verification</CardTitle>
          <CardDescription>
            Compare each record with its photo. You cannot verify a record you
            created; a baseline only exists once someone else verifies it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {queue.records.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              Nothing is waiting for verification.
            </p>
          ) : (
            <ul
              className="flex flex-col gap-4"
              aria-label="Records awaiting verification"
            >
              {queue.records.map((r) => (
                <li
                  key={r.id}
                  className="flex flex-col gap-3 rounded-md border p-4"
                >
                  <Summary r={r} />
                  {r.evidence_file_id ? (
                    <ViewEvidenceButton
                      evidenceFileId={r.evidence_file_id}
                      recordId={r.id}
                    />
                  ) : (
                    <p className="text-muted-foreground text-xs">
                      No photo attached.
                    </p>
                  )}
                  <VerifyRecordForm
                    recordId={r.id}
                    createdByMe={r.created_by === ctx.userId}
                  />
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recently verified</CardTitle>
          <CardDescription>
            A verified record is immutable. If one is wrong it can only be
            reversed, with a reason, and the reversal is audited.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!verified.ok ? (
            <Alert variant="destructive">
              Recently verified records could not be loaded.
            </Alert>
          ) : verified.records.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No verified records yet.
            </p>
          ) : (
            <ul
              className="flex flex-col gap-4"
              aria-label="Recently verified records"
            >
              {verified.records.map((r) => (
                <li
                  key={r.id}
                  className="flex flex-col gap-3 rounded-md border p-4"
                >
                  <Summary r={r} />
                  {r.created_by === ctx.userId ? (
                    <p className="text-muted-foreground text-xs">
                      You created this record; someone else must reverse it if
                      it is wrong.
                    </p>
                  ) : (
                    <details>
                      <summary className="cursor-pointer text-sm underline">
                        Reverse this verification…
                      </summary>
                      <div className="mt-3 max-w-md">
                        <ReverseVerificationForm recordId={r.id} />
                      </div>
                    </details>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </>
  );
}

export default function VerificationPage() {
  return (
    <AppShell
      title="Service verification"
      description="Verifier ≠ creator (DEC-24). Only verified records set a baseline (DEC-20)."
    >
      <ServiceNav />
      <Suspense fallback={<Loading label="Loading the queue…" />}>
        <Content />
      </Suspense>
    </AppShell>
  );
}
