import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { AppShell, Loading } from "@/components/app-shell";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  licenceBadge,
  readWarningDays,
  sastToday,
} from "@/modules/drivers/domain/licence-expiry";
import {
  getDriver,
  listBranches,
  listLicences,
} from "@/modules/drivers/server/queries";
import {
  DriverStatusForm,
  EditDriverForm,
  ResetPinForm,
} from "@/modules/drivers/ui/driver-forms";
import { LicenceBadge } from "@/modules/drivers/ui/licence-badge";
import {
  LicenceForm,
  VerifyLicenceForm,
  ViewEvidenceButton,
} from "@/modules/drivers/ui/licence-forms";
import { requireSession } from "@/modules/identity-access/server/session";

const VERIFICATION_LABEL: Record<string, string> = {
  recorded: "Awaiting verification",
  verified: "Verified",
  rejected: "Rejected",
};

async function Content({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireSession("full");
  await connection();
  const { id } = await params;
  const db = await createSupabaseServerClient();
  const found = await getDriver(db, id);
  if (!found.ok) {
    return (
      <Alert variant="destructive">
        This driver could not be loaded. Please refresh the page.
      </Alert>
    );
  }
  const driver = found.driver;
  if (!driver)
    return (
      <Alert>
        That driver was not found, or you do not have access to them.
      </Alert>
    );

  const [{ data: canManage }, licences, branches] = await Promise.all([
    db.rpc("has_permission", {
      permission_key: "driver.manage",
      target_branch_id: driver.branchId,
    }),
    listLicences(db, id),
    listBranches(db),
  ]);
  const manage = canManage === true;
  const isSelf = driver.profileId === ctx.userId; // DEC-24: no self-verification / self status change
  const today = sastToday(new Date());
  const branchName = branches.ok
    ? branches.branches.find((b) => b.id === driver.branchId)?.name
    : undefined;

  return (
    <>
      <section aria-labelledby="who" className="flex flex-col gap-1">
        <h2 id="who" className="text-lg font-medium">
          {driver.displayName} · {driver.employeeNumber}
        </h2>
        <p className="text-muted-foreground text-sm">
          {branchName ?? "Branch"} ·{" "}
          {driver.activeStatus === "active" ? "Active" : "Inactive"}
          {driver.pinChangePending ? " · PIN change pending" : ""}
        </p>
        <div>
          <LicenceBadge
            badge={licenceBadge(driver.licence, today, readWarningDays())}
          />
        </div>
      </section>

      {manage && !isSelf ? (
        <section aria-labelledby="details" className="flex flex-col gap-3">
          <h2 id="details" className="text-lg font-medium">
            Details
          </h2>
          <EditDriverForm
            driverId={driver.id}
            displayName={driver.displayName}
            phone={driver.phone}
          />
        </section>
      ) : null}

      <section aria-labelledby="licences" className="flex flex-col gap-3">
        <h2 id="licences" className="text-lg font-medium">
          Licence records
        </h2>
        {!licences.ok ? (
          <Alert variant="destructive">
            Licence records could not be loaded. Please refresh the page.
          </Alert>
        ) : licences.licences.length === 0 ? (
          <Alert>No licence has been recorded for this driver yet.</Alert>
        ) : (
          <ul className="flex flex-col gap-3">
            {licences.licences.map((l) => (
              <li
                key={l.id}
                className="flex flex-col gap-2 rounded-lg border px-4 py-3"
              >
                <div className="flex flex-wrap items-center gap-3">
                  <p className="font-medium">
                    Code {l.licenceCode}
                    {l.licenceNumber ? ` · ${l.licenceNumber}` : ""}
                  </p>
                  <Badge
                    variant={
                      l.verificationStatus === "verified"
                        ? "success"
                        : l.verificationStatus === "rejected"
                          ? "destructive"
                          : "warning"
                    }
                  >
                    {VERIFICATION_LABEL[l.verificationStatus] ??
                      l.verificationStatus}
                  </Badge>
                </div>
                <p className="text-muted-foreground text-sm">
                  Issued {l.issueDate} · expires {l.expiryDate}
                  {l.prdpRequired
                    ? ` · PrDP expires ${l.prdpExpiryDate ?? "—"}`
                    : ""}
                </p>
                {l.licenceNumber === null ? (
                  <p className="text-muted-foreground text-sm">
                    The licence number and photo are restricted to people who
                    may view licence details.
                  </p>
                ) : null}
                {l.evidenceFileId ? (
                  <ViewEvidenceButton
                    evidenceFileId={l.evidenceFileId}
                    licenceId={l.id}
                  />
                ) : null}
                {manage &&
                l.licenceNumber !== null &&
                l.verificationStatus === "recorded" ? (
                  l.createdBy === ctx.userId ? (
                    <p className="text-muted-foreground text-sm">
                      You recorded this, so a different administrator must
                      verify it.
                    </p>
                  ) : isSelf ? (
                    <p className="text-muted-foreground text-sm">
                      You cannot verify your own licence.
                    </p>
                  ) : (
                    <VerifyLicenceForm licenceId={l.id} driverId={driver.id} />
                  )
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {manage && driver.activeStatus === "active" ? (
        <section aria-labelledby="add-licence" className="flex flex-col gap-3">
          <h2 id="add-licence" className="text-lg font-medium">
            Record a licence
          </h2>
          <LicenceForm driverId={driver.id} branchId={driver.branchId} />
        </section>
      ) : null}

      {manage && !isSelf ? (
        <>
          <section aria-labelledby="pin" className="flex flex-col gap-3">
            <h2 id="pin" className="text-lg font-medium">
              Sign-in PIN
            </h2>
            <p className="text-muted-foreground text-sm">
              Issues a new temporary PIN and clears any sign-in lock. The old
              PIN stops working. The new PIN is shown once.
            </p>
            <ResetPinForm driverId={driver.id} />
          </section>
          <section aria-labelledby="status" className="flex flex-col gap-3">
            <h2 id="status" className="text-lg font-medium">
              Status
            </h2>
            <p className="text-muted-foreground text-sm">
              Deactivating stops sign-in; the driver and their history are kept,
              never deleted.
            </p>
            <DriverStatusForm
              driverId={driver.id}
              status={driver.activeStatus}
            />
          </section>
        </>
      ) : null}
      <p>
        <Link href="/drivers" className="text-sm hover:underline">
          ← Back to drivers
        </Link>
      </p>
    </>
  );
}

export default function DriverPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return (
    <AppShell
      title="Driver"
      description="Details, licence records and sign-in."
    >
      <Suspense fallback={<Loading label="Loading driver…" />}>
        <Content params={params} />
      </Suspense>
    </AppShell>
  );
}
