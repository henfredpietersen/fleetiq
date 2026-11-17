import { Suspense } from "react";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { verifiedTotpFactorId } from "@/modules/identity-access/server/mfa";
import { requireSession } from "@/modules/identity-access/server/session";
import {
  AuthLoading,
  AuthShell,
} from "@/modules/identity-access/ui/auth-shell";
import { MfaForm } from "@/modules/identity-access/ui/mfa-form";

async function Content() {
  await requireSession("mfa"); // redirects away unless MFA is actually the next step
  const supabase = await createSupabaseServerClient();
  const enrolled = (await verifiedTotpFactorId(supabase)) !== null;
  return <MfaForm mode={enrolled ? "verify" : "enrol"} />;
}

export default function MfaPage() {
  return (
    <AuthShell
      title="Two-step verification"
      description="Your role requires an authenticator code before you can continue."
    >
      <Suspense fallback={<AuthLoading />}>
        <Content />
      </Suspense>
    </AuthShell>
  );
}
