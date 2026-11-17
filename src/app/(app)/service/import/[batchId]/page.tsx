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
import { uuidField } from "@/modules/fleet-vehicles/domain/vehicle-schema";
import { requireSession } from "@/modules/identity-access/server/session";
import {
  importErrorLabel,
  summariseRows,
} from "@/modules/service-monitoring/domain/csv-import";
import {
  getImportBatch,
  listVehicleOptions,
} from "@/modules/service-monitoring/server/queries";
import { AttachEvidenceForm } from "@/modules/service-monitoring/ui/import-forms";
import { ServiceNav } from "@/modules/service-monitoring/ui/service-nav";

async function Content({ params }: { params: Promise<{ batchId: string }> }) {
  const ctx = await requireSession("full");
  const { batchId } = await params;
  if (!uuidField.safeParse(batchId).success) return <NotFound />;
  const db = await createSupabaseServerClient();
  const [res, vehicles] = await Promise.all([
    getImportBatch(db, batchId),
    listVehicleOptions(db),
  ]);
  if (!res.ok)
    return res.reason === "not_found" ? (
      <NotFound />
    ) : (
      <Alert variant="destructive">
        This import could not be loaded. Please refresh the page.
      </Alert>
    );
  const branchOf = new Map(
    (vehicles.ok ? vehicles.vehicles : []).map((v) => [v.id, v.branchId]),
  );
  const sum = summariseRows(res.rows);
  const mine = res.batch.created_by === ctx.userId;
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>{res.batch.filename}</CardTitle>
          <CardDescription>
            Validation report: {sum.total} rows · {sum.valid} ready for evidence
            · {sum.invalid} with errors · {sum.imported} imported
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {sum.invalid > 0 ? (
            <Alert>
              Rows with errors cannot be imported. Fix them in the file and
              upload it again; nothing from this file is changed.
            </Alert>
          ) : null}
          {!mine && sum.valid > 0 ? (
            <Alert>
              Only the person who uploaded this file can attach its evidence.
            </Alert>
          ) : null}
          <ul className="flex flex-col gap-3" aria-label="Import rows">
            {res.rows.map((r) => (
              <li
                key={r.id}
                className="flex flex-col gap-2 rounded-md border p-4"
              >
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-muted-foreground text-sm">
                    Row {r.row_number}
                  </span>
                  <span className="font-medium">
                    {r.registration_number ?? "—"}
                  </span>
                  <span className="text-sm">
                    {r.service_date_raw ?? "—"} · {r.odometer_raw ?? "—"} km ·{" "}
                    {r.service_type ?? "—"}
                  </span>
                  <Badge
                    variant={
                      r.row_status === "valid"
                        ? "success"
                        : r.row_status === "imported"
                          ? "outline"
                          : "destructive"
                    }
                  >
                    {r.row_status === "valid"
                      ? "Ready for evidence"
                      : r.row_status === "imported"
                        ? "Imported — awaiting verification"
                        : "Error"}
                  </Badge>
                </div>
                {r.errors.length > 0 ? (
                  <ul className="text-destructive list-disc pl-5 text-sm">
                    {r.errors.map((e) => (
                      <li key={e}>{importErrorLabel(e)}</li>
                    ))}
                  </ul>
                ) : null}
                {r.row_status === "valid" &&
                mine &&
                r.vehicle_id &&
                branchOf.get(r.vehicle_id) ? (
                  <AttachEvidenceForm
                    rowId={r.id}
                    batchId={res.batch.id}
                    branchId={branchOf.get(r.vehicle_id) as string}
                  />
                ) : null}
                {r.row_status === "imported" ? (
                  <p className="text-muted-foreground text-xs">
                    A different maintenance administrator verifies it in the{" "}
                    <Link href="/service/verification" className="underline">
                      verification queue
                    </Link>
                    .
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </>
  );
}

function NotFound() {
  return (
    <Alert>
      This import was not found.{" "}
      <Link href="/service/import" className="underline">
        Back to imports
      </Link>
    </Alert>
  );
}

export default function ImportBatchPage({
  params,
}: {
  params: Promise<{ batchId: string }>;
}) {
  return (
    <AppShell
      title="Import review"
      description="Validation report and evidence for each row (DEC-20)."
    >
      <ServiceNav />
      <Suspense fallback={<Loading label="Loading the import…" />}>
        <Content params={params} />
      </Suspense>
    </AppShell>
  );
}
