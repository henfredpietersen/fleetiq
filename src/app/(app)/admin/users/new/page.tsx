import { Suspense } from "react";
import { Alert } from "@/components/ui/alert";
import { AppShell, Loading } from "@/components/app-shell";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { canManageUsers } from "@/modules/identity-access/server/admin-queries";
import { requireSession } from "@/modules/identity-access/server/session";
import { CreateStaffForm } from "@/modules/identity-access/ui/admin-forms";

async function Content() {
  await requireSession("full");
  if (!(await canManageUsers(await createSupabaseServerClient()))) {
    return (
      <Alert>
        You do not have permission to create staff users. This needs the system
        administrator role (users.roles.manage).
      </Alert>
    );
  }
  return <CreateStaffForm />;
}

export default function NewStaffUserPage() {
  return (
    <AppShell
      title="Create staff user"
      description="Creates the sign-in and a temporary password. Roles are assigned afterwards."
    >
      <Suspense fallback={<Loading label="Loading…" />}>
        <Content />
      </Suspense>
    </AppShell>
  );
}
