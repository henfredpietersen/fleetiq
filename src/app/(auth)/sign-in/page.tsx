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
import { DriverSignInForm } from "@/modules/identity-access/ui/driver-sign-in-form";

const NOTICES: Record<string, string> = {
  expired: "Your session has ended. Please sign in again.",
  inactive: "This account cannot sign in. Contact your supervisor.",
};

async function Content({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>;
}) {
  const ctx = await getSessionContext();
  if (ctx && ctx.profile.status === "active") redirect(stepFor(ctx));
  const { reason } = await searchParams;
  return (
    <>
      <DriverSignInForm notice={reason ? NOTICES[reason] : undefined} />
      <Link
        href="/staff/sign-in"
        className="text-center text-sm underline underline-offset-4"
      >
        Office / management sign-in
      </Link>
    </>
  );
}

export default function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>;
}) {
  return (
    <AuthShell
      title="Driver sign-in"
      description="Enter your employee number and PIN."
    >
      <Suspense fallback={<AuthLoading />}>
        <Content searchParams={searchParams} />
      </Suspense>
    </AuthShell>
  );
}
