import { Suspense } from "react";
import { Alert } from "@/components/ui/alert";
import { AppShell, Loading } from "@/components/app-shell";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  listBranches,
  manageableBranchIds,
} from "@/modules/drivers/server/queries";
import { CreateDriverForm } from "@/modules/drivers/ui/driver-forms";
import { requireSession } from "@/modules/identity-access/server/session";

async function Content() {
  await requireSession("full");
  const db = await createSupabaseServerClient();
  const res = await listBranches(db);
  if (!res.ok) {
    return (
      <Alert variant="destructive">
        Branches could not be loaded. Please refresh the page.
      </Alert>
    );
  }
  const allowed = await manageableBranchIds(db, res.branches);
  const branches = res.branches.filter((b) => allowed.has(b.id));
  if (branches.length === 0) {
    return (
      <Alert>
        You do not have permission to add drivers. This needs the fleet
        administrator or branch manager role (driver.manage).
      </Alert>
    );
  }
  return <CreateDriverForm branches={branches} />;
}

export default function NewDriverPage() {
  return (
    <AppShell
      title="Add driver"
      description="Creates the driver's sign-in, driver record and role, and issues a temporary PIN."
    >
      <Suspense fallback={<Loading label="Loading…" />}>
        <Content />
      </Suspense>
    </AppShell>
  );
}
