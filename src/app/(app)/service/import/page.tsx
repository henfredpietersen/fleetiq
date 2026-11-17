import { randomUUID } from "node:crypto";
import Link from "next/link";
import { Suspense } from "react";
import { Alert } from "@/components/ui/alert";
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
import { listImportBatches } from "@/modules/service-monitoring/server/queries";
import { CsvImportForm } from "@/modules/service-monitoring/ui/import-forms";
import { ServiceNav } from "@/modules/service-monitoring/ui/service-nav";

async function Content() {
  await requireSession("full");
  const db = await createSupabaseServerClient();
  const res = await listImportBatches(db);
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Import go-live baselines</CardTitle>
          <CardDescription>
            Upload a CSV, review the validation report, then attach the invoice,
            job card or service-book photo to each valid row (DEC-20). Each row
            becomes a “recorded” service record; a maintenance administrator
            other than you verifies each one separately.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CsvImportForm submissionId={randomUUID()} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Previous imports</CardTitle>
        </CardHeader>
        <CardContent>
          {!res.ok ? (
            <Alert variant="destructive">
              Previous imports could not be loaded.
            </Alert>
          ) : res.batches.length === 0 ? (
            <p className="text-muted-foreground text-sm">No imports yet.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {res.batches.map((b) => (
                <li key={b.id} className="text-sm">
                  <Link
                    href={`/service/import/${b.id}`}
                    className="font-medium hover:underline"
                  >
                    {b.filename}
                  </Link>{" "}
                  <span className="text-muted-foreground">
                    · {formatDateTime(b.created_at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </>
  );
}

export default function ImportPage() {
  return (
    <AppShell
      title="Baseline import"
      description="Reviewed import of historical service baselines."
    >
      <ServiceNav />
      <Suspense fallback={<Loading label="Loading…" />}>
        <Content />
      </Suspense>
    </AppShell>
  );
}
