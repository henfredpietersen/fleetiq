import Link from "next/link";
import { Suspense } from "react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
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
import {
  canManageUsers,
  listStaff,
} from "@/modules/identity-access/server/admin-queries";
import { requireSession } from "@/modules/identity-access/server/session";

async function Content() {
  await requireSession("full");
  const db = await createSupabaseServerClient();
  if (!(await canManageUsers(db))) {
    return (
      <Alert>
        You do not have permission to manage staff users. This needs the system
        administrator role (users.roles.manage).
      </Alert>
    );
  }
  const res = await listStaff(db);
  if (!res.ok) {
    return (
      <Alert variant="destructive">
        Staff users could not be loaded. Please refresh the page; if it keeps
        happening, contact an administrator.
      </Alert>
    );
  }
  if (res.staff.length === 0) {
    return (
      <Alert>
        There are no staff users yet. Use “Create staff user” to add the first
        one.
      </Alert>
    );
  }
  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Email</TableHead>
            <TableHead>Roles</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {res.staff.map((s) => (
            <TableRow key={s.id}>
              <TableCell className="font-medium">
                <Link href={`/admin/users/${s.id}`} className="hover:underline">
                  {s.displayName}
                </Link>
              </TableCell>
              <TableCell>{s.email ?? "—"}</TableCell>
              <TableCell>
                {s.activeRoles.length ? (
                  s.activeRoles.join(", ")
                ) : (
                  <span className="text-muted-foreground">No roles yet</span>
                )}
              </TableCell>
              <TableCell>
                {s.status !== "active" ? (
                  <Badge variant="destructive">{s.status}</Badge>
                ) : s.passwordChangePending ? (
                  <Badge variant="warning">Password change pending</Badge>
                ) : (
                  <Badge variant="success">Active</Badge>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export default function StaffUsersPage() {
  return (
    <AppShell
      title="Staff users"
      description="Office and management accounts, their roles and branch scope."
      actions={
        <Link href="/admin/users/new" className={buttonVariants()}>
          Create staff user
        </Link>
      }
    >
      <Suspense fallback={<Loading label="Loading staff users…" />}>
        <Content />
      </Suspense>
    </AppShell>
  );
}
