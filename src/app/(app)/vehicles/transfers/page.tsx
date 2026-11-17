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
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireSession } from "@/modules/identity-access/server/session";
import { formatDateTime } from "@/modules/fleet-vehicles/domain/format";
import {
  listBranches,
  listPendingTransfers,
} from "@/modules/fleet-vehicles/server/queries";
import { Loading, PageShell } from "@/modules/fleet-vehicles/ui/page-shell";
import {
  CancelTransferForm,
  DecisionForm,
} from "@/modules/fleet-vehicles/ui/transfer-forms";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const DONE: Record<string, string> = {
  approved: "Transfer approved. The vehicle now belongs to the new branch.",
  rejected: "Transfer rejected. The vehicle stays in its current branch.",
  cancelled: "Your transfer request was cancelled.",
};

async function Content({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await requireSession("full");
  const decided = (await searchParams).decided;
  const doneMessage = typeof decided === "string" ? DONE[decided] : undefined;

  const db = await createSupabaseServerClient();
  const [res, branchRes] = await Promise.all([
    listPendingTransfers(db, ctx.userId),
    listBranches(db),
  ]);
  if (!res.ok) {
    return (
      <Alert variant="destructive">
        Pending transfers could not be loaded. Please refresh the page.
      </Alert>
    );
  }
  const branchName = new Map(
    (branchRes.ok ? branchRes.branches : []).map((b) => [b.id, b.name]),
  );
  const name = (id: string | null) =>
    id ? (branchName.get(id) ?? "a branch") : "—";

  return (
    <>
      {doneMessage ? <Alert variant="success">{doneMessage}</Alert> : null}
      {res.transfers.length === 0 ? (
        <Alert>No transfers are waiting for approval.</Alert>
      ) : (
        <ul className="flex flex-col gap-4" aria-label="Pending transfers">
          {res.transfers.map((t) => (
            <li key={t.id}>
              <Card>
                <CardHeader>
                  <CardTitle>
                    <Link
                      href={`/vehicles/${t.vehicleId}`}
                      className="hover:underline"
                    >
                      {t.vehicleLabel}
                    </Link>
                  </CardTitle>
                  <CardDescription>
                    {name(t.fromBranchId)} → {name(t.toBranchId)} · requested{" "}
                    {formatDateTime(t.createdAt)}
                    {t.requestedByMe ? " · by you" : ""}
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-4">
                  <p className="text-sm">
                    <span className="text-muted-foreground">Reason: </span>
                    {t.reason ?? "—"}
                  </p>
                  {t.requestedByMe ? (
                    <>
                      <p className="text-muted-foreground text-sm">
                        You cannot approve your own request. Another fleet
                        administrator must decide it.
                      </p>
                      <CancelTransferForm approvalId={t.id} />
                    </>
                  ) : (
                    <DecisionForm approvalId={t.id} />
                  )}
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export default function TransfersPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  return (
    <PageShell
      title="Pending transfers"
      description="Branch transfers need a fleet administrator other than the requester (DEC-31, DEC-24)."
    >
      <Suspense fallback={<Loading label="Loading transfers…" />}>
        <Content searchParams={searchParams} />
      </Suspense>
    </PageShell>
  );
}
