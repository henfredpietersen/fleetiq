import Link from "next/link";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import {
  getSessionContext,
  stepFor,
} from "@/modules/identity-access/server/session";
import {
  AuthLoading,
  AuthShell,
} from "@/modules/identity-access/ui/auth-shell";
import { StaffSignInForm } from "@/modules/identity-access/ui/staff-sign-in-form";

async function Content() {
  const ctx = await getSessionContext();
  if (ctx && ctx.profile.status === "active") redirect(stepFor(ctx));
  return (
    <>
      <StaffSignInForm />
      <Link
        href="/sign-in"
        className="text-center text-sm underline underline-offset-4"
      >
        Driver sign-in
      </Link>
    </>
  );
}

export default function StaffSignInPage() {
  return (
    <AuthShell
      title="Office sign-in"
      description="Email and password. Administrators and approvers also need an authenticator code."
    >
      <Suspense fallback={<AuthLoading />}>
        <Content />
      </Suspense>
    </AuthShell>
  );
}
