import { Suspense } from "react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
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
  getStaffUser,
  listAssignable,
} from "@/modules/identity-access/server/admin-queries";
import { requireSession } from "@/modules/identity-access/server/session";
import {
  AssignRoleForm,
  ResetPasswordForm,
  RevokeRoleButton,
} from "@/modules/identity-access/ui/admin-forms";

const day = (iso: string) => iso.slice(0, 10);

async function Content({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireSession("full");
  const { id } = await params;
  const db = await createSupabaseServerClient();
  if (!(await canManageUsers(db))) {
    return (
      <Alert>
        You do not have permission to manage staff users. This needs the system
        administrator role (users.roles.manage).
      </Alert>
    );
  }
  const [user, options] = await Promise.all([
    getStaffUser(db, id),
    listAssignable(db),
  ]);
  if (!user) return <Alert>That staff user was not found.</Alert>;
  if (!options) {
    return (
      <Alert variant="destructive">
        Roles and branches could not be loaded. Please refresh the page.
      </Alert>
    );
  }
  const isSelf = user.profile.id === ctx.userId; // DEC-24: nobody changes their own roles
  return (
    <>
      <section aria-labelledby="who" className="flex flex-col gap-1">
        <h2 id="who" className="text-lg font-medium">
          {user.profile.displayName}
        </h2>
        <p className="text-muted-foreground text-sm">
          {user.profile.email ?? "No email"} ·{" "}
          {user.profile.status === "active" ? "Active" : user.profile.status}
          {user.profile.passwordChangePending
            ? " · password change pending"
            : ""}
        </p>
      </section>

      <section aria-labelledby="roles" className="flex flex-col gap-3">
        <h2 id="roles" className="text-lg font-medium">
          Roles
        </h2>
        {user.grants.length === 0 ? (
          <Alert>No roles have been assigned yet.</Alert>
        ) : (
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Role</TableHead>
                  <TableHead>Scope</TableHead>
                  <TableHead>From</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {user.grants.map((g) => (
                  <TableRow key={g.id}>
                    <TableCell className="font-medium">{g.roleLabel}</TableCell>
                    <TableCell>{g.branchName ?? "All branches"}</TableCell>
                    <TableCell>{day(g.effectiveFrom)}</TableCell>
                    <TableCell>
                      {g.active ? (
                        <Badge variant="success">Active</Badge>
                      ) : g.pending ? (
                        <Badge variant="warning">Not started</Badge>
                      ) : (
                        <Badge variant="outline">
                          Ended {g.effectiveTo ? day(g.effectiveTo) : ""}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      {(g.active || g.pending) && !isSelf ? (
                        <RevokeRoleButton
                          grantId={g.id}
                          userId={user.profile.id}
                          label={g.roleLabel}
                        />
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      {isSelf ? (
        <Alert>
          You cannot change your own roles or reset your own password here.
          Another administrator must do that.
        </Alert>
      ) : (
        <>
          <section aria-labelledby="assign" className="flex flex-col gap-3">
            <h2 id="assign" className="text-lg font-medium">
              Assign a role
            </h2>
            <AssignRoleForm
              userId={user.profile.id}
              roles={options.roles.map((r) => ({
                id: r.id,
                description: r.description ?? r.name,
              }))}
              branches={options.branches}
            />
          </section>
          <section aria-labelledby="reset" className="flex flex-col gap-3">
            <h2 id="reset" className="text-lg font-medium">
              Password
            </h2>
            <p className="text-muted-foreground text-sm">
              Issues a new temporary password. The user must choose their own at
              next sign-in.
            </p>
            <ResetPasswordForm userId={user.profile.id} />
          </section>
        </>
      )}
    </>
  );
}

export default function StaffUserPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return (
    <AppShell
      title="Staff user"
      description="Roles, branch scope and password."
    >
      <Suspense fallback={<Loading label="Loading user…" />}>
        <Content params={params} />
      </Suspense>
    </AppShell>
  );
}
