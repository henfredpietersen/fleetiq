import { Suspense } from "react";
import { connection } from "next/server";
import Link from "next/link";
import { Alert } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireSession } from "@/modules/identity-access/server/session";
import { signOutAction } from "@/modules/identity-access/server/actions";
import {
  AuthLoading,
  AuthShell,
} from "@/modules/identity-access/ui/auth-shell";

/** Signed-in placeholder: shows who you are and the role/branch scope RLS will apply. No dashboards yet. */
async function Content() {
  const ctx = await requireSession("full");
  const supabase = await createSupabaseServerClient();
  await connection(); // current time is request-specific
  const nowIso = new Date().toISOString();
  const [{ data: grants, error }, { data: branches }] = await Promise.all([
    supabase
      .from("user_roles")
      .select(
        "id, branch_id, effective_from, effective_to, roles(name, description)",
      )
      .eq("user_id", ctx.userId)
      .lte("effective_from", nowIso)
      .order("effective_from"),
    supabase.from("branches").select("id, name"),
  ]);
  const branchName = new Map((branches ?? []).map((b) => [b.id, b.name]));
  const active = (grants ?? []).filter(
    (g) => g.effective_to === null || g.effective_to > nowIso,
  );

  return (
    <>
      <div>
        <p className="font-medium">{ctx.profile.displayName}</p>
        <p className="text-muted-foreground text-sm">
          {ctx.profile.userType === "driver" ? "Driver" : "Office user"}
          {ctx.aal === "aal2" ? " · two-step verified" : ""}
        </p>
      </div>
      {error ? (
        <Alert variant="destructive">
          Your roles could not be loaded. Please try again.
        </Alert>
      ) : active.length === 0 ? (
        <Alert>
          No active role is assigned to your account yet. Ask an administrator
          to grant one.
        </Alert>
      ) : (
        <ul
          className="flex flex-col gap-3"
          aria-label="Your roles and branch scope"
        >
          {active.map((g) => (
            <li key={g.id} className="rounded-lg border px-4 py-3">
              <p className="font-medium">
                {g.roles?.description ?? g.roles?.name}
              </p>
              <p className="text-muted-foreground text-sm">
                {g.branch_id
                  ? `Branch: ${branchName.get(g.branch_id) ?? "unknown"}`
                  : "All branches (company-wide)"}
              </p>
            </li>
          ))}
        </ul>
      )}
      {ctx.profile.userType === "driver" ? (
        <Link
          href="/my-allocations"
          className={buttonVariants({
            size: "lg",
            className: "min-h-14 w-full",
          })}
        >
          My allocations
        </Link>
      ) : null}
      <form action={signOutAction}>
        <Button type="submit" variant="outline" size="lg" className="w-full">
          Sign out
        </Button>
      </form>
    </>
  );
}

export default function HomePage() {
  return (
    <AuthShell
      title="Signed in"
      description="Dashboards arrive in later phases."
    >
      <Suspense fallback={<AuthLoading />}>
        <Content />
      </Suspense>
    </AuthShell>
  );
}
