import Link from "next/link";
import { Suspense } from "react";
import { connection } from "next/server";
import { Alert } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
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
import { listDevices } from "@/modules/drivers/server/device-service";
import {
  listBranches,
  listDrivers,
  manageableBranchIds,
} from "@/modules/drivers/server/queries";
import {
  DeviceRowActions,
  DeviceStatusBadge,
  RegisterDeviceForm,
} from "@/modules/drivers/ui/device-forms";
import { requireSession } from "@/modules/identity-access/server/session";

async function Content() {
  await requireSession("full");
  await connection();
  const db = await createSupabaseServerClient();
  const [branchRes, devRes, drvRes] = await Promise.all([
    listBranches(db),
    listDevices(db),
    listDrivers(db, { status: "active" }),
  ]);
  if (!branchRes.ok || !devRes.ok || !drvRes.ok) {
    return (
      <Alert variant="destructive">
        The company phones could not be loaded. Please refresh the page; if it
        keeps happening, contact an administrator.
      </Alert>
    );
  }
  const manageable = await manageableBranchIds(db, branchRes.branches);
  const branches = branchRes.branches.filter((b) => manageable.has(b.id));
  if (branches.length === 0) {
    return (
      <Alert>
        Managing company phones needs the driver management permission for a
        branch. You do not have it.
      </Alert>
    );
  }
  const driversByBranch = (branchId: string) =>
    drvRes.drivers
      .filter((d) => d.branchId === branchId)
      .map((d) => ({
        id: d.id,
        label: `${d.employeeNumber} · ${d.displayName}`,
      }));

  return (
    <>
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Register a phone</h2>
        <RegisterDeviceForm branches={branches} />
      </section>
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Company phones</h2>
        {devRes.devices.length === 0 ? (
          <Alert>
            No company phones are registered yet. Open “This phone” on a company
            phone to get its code, then register it above.
          </Alert>
        ) : (
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Phone</TableHead>
                  <TableHead>Branch</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Issued to</TableHead>
                  <TableHead>Manage</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {devRes.devices.map((d) => (
                  <TableRow key={d.id} data-testid="device-row">
                    <TableCell className="font-medium">
                      {d.label ?? d.assetTag ?? "Company phone"}
                      <span className="text-muted-foreground block font-mono text-xs">
                        {d.shortCode}
                        {d.assetTag && d.label ? ` · ${d.assetTag}` : ""}
                      </span>
                    </TableCell>
                    <TableCell>{d.branchName}</TableCell>
                    <TableCell>
                      <DeviceStatusBadge status={d.status} />
                    </TableCell>
                    <TableCell>
                      {d.driverEmployeeNumber
                        ? `${d.driverEmployeeNumber} · ${d.driverName ?? ""}`
                        : "Not issued"}
                    </TableCell>
                    <TableCell>
                      <DeviceRowActions
                        d={d}
                        drivers={driversByBranch(d.branchId)}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
    </>
  );
}

export default function DevicesPage() {
  return (
    <AppShell
      title="Company phones"
      description="Which company phone is issued to which driver. A different phone is flagged on an inspection, never refused."
    >
      <Link
        href="/drivers"
        className={buttonVariants({ variant: "outline", className: "w-fit" })}
      >
        Back to drivers
      </Link>
      <Suspense fallback={<Loading label="Loading company phones…" />}>
        <Content />
      </Suspense>
    </AppShell>
  );
}
