import Link from "next/link";
import { Suspense } from "react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
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
import { driverFilterSchema } from "@/modules/drivers/domain/driver-schema";
import {
  licenceBadge,
  readWarningDays,
  sastToday,
} from "@/modules/drivers/domain/licence-expiry";
import {
  listBranches,
  listDrivers,
  manageableBranchIds,
} from "@/modules/drivers/server/queries";
import { LicenceBadge } from "@/modules/drivers/ui/licence-badge";
import { requireSession } from "@/modules/identity-access/server/session";
import { connection } from "next/server";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

async function Content({ searchParams }: { searchParams: SearchParams }) {
  await requireSession("full");
  await connection(); // "today" is request-specific
  const raw = await searchParams;
  const one = (k: string) => (typeof raw[k] === "string" ? raw[k] : undefined);
  const parsed = driverFilterSchema.safeParse({
    q: one("q"),
    branchId: one("branch"),
    status: one("status"),
  });
  const filters = parsed.success ? parsed.data : {};
  const db = await createSupabaseServerClient();
  const [branchRes, listRes] = await Promise.all([
    listBranches(db),
    listDrivers(db, filters),
  ]);
  if (!branchRes.ok || !listRes.ok) {
    return (
      <Alert variant="destructive">
        The driver register could not be loaded. Please refresh the page; if it
        keeps happening, contact an administrator.
      </Alert>
    );
  }
  const branchName = new Map(branchRes.branches.map((b) => [b.id, b.name]));
  const canCreate =
    (await manageableBranchIds(db, branchRes.branches)).size > 0;
  const today = sastToday(new Date());
  const warningDays = readWarningDays();
  const filtered = Boolean(filters.q || filters.branchId || filters.status);

  return (
    <>
      <form
        method="get"
        className="flex flex-wrap items-end gap-4"
        aria-label="Filter drivers"
      >
        <div className="flex min-w-56 flex-col gap-2">
          <Label htmlFor="q">Search</Label>
          <Input
            id="q"
            name="q"
            defaultValue={filters.q ?? ""}
            placeholder="Employee number or name"
            maxLength={50}
          />
        </div>
        <div className="flex min-w-44 flex-col gap-2">
          <Label htmlFor="branch">Branch</Label>
          <Select
            id="branch"
            name="branch"
            defaultValue={filters.branchId ?? ""}
          >
            <option value="">All my branches</option>
            {branchRes.branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex min-w-40 flex-col gap-2">
          <Label htmlFor="status">Status</Label>
          <Select id="status" name="status" defaultValue={filters.status ?? ""}>
            <option value="">Any status</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </Select>
        </div>
        <Button type="submit">Apply</Button>
        {filtered ? (
          <Link
            href="/drivers"
            className={buttonVariants({ variant: "ghost" })}
          >
            Clear
          </Link>
        ) : null}
        {canCreate ? (
          <Link
            href="/drivers/new"
            className={buttonVariants({ className: "ml-auto" })}
          >
            Add driver
          </Link>
        ) : null}
      </form>

      {listRes.drivers.length === 0 ? (
        <Alert>
          {filtered
            ? "No drivers match these filters."
            : "There are no drivers in the branches you can see yet."}
          {!filtered && canCreate
            ? " Use “Add driver” to register the first one."
            : ""}
        </Alert>
      ) : (
        <>
          <p className="text-muted-foreground text-sm" aria-live="polite">
            {listRes.drivers.length} driver
            {listRes.drivers.length === 1 ? "" : "s"}
            {listRes.drivers.length === 500
              ? " (showing the first 500; narrow the filters)"
              : ""}
          </p>
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Employee no.</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Branch</TableHead>
                  <TableHead>Licence</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {listRes.drivers.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell className="font-medium">
                      <Link
                        href={`/drivers/${d.id}`}
                        className="hover:underline"
                      >
                        {d.employeeNumber}
                      </Link>
                    </TableCell>
                    <TableCell>{d.displayName}</TableCell>
                    <TableCell>{branchName.get(d.branchId) ?? "—"}</TableCell>
                    <TableCell>
                      <LicenceBadge
                        badge={licenceBadge(d.licence, today, warningDays)}
                      />
                    </TableCell>
                    <TableCell>
                      {d.activeStatus === "active" ? (
                        d.pinChangePending ? (
                          <Badge variant="warning">PIN change pending</Badge>
                        ) : (
                          <Badge variant="success">Active</Badge>
                        )
                      ) : (
                        <Badge variant="outline">Inactive</Badge>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </>
  );
}

export default function DriversPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  return (
    <AppShell
      title="Drivers"
      description="The driver register for the branches you have access to."
    >
      <Suspense fallback={<Loading label="Loading drivers…" />}>
        <Content searchParams={searchParams} />
      </Suspense>
    </AppShell>
  );
}
