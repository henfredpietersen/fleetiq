import { Suspense } from "react";
import { loadAuthConfig } from "@/modules/identity-access/domain/auth-config";
import { requireSession } from "@/modules/identity-access/server/session";
import {
  AuthLoading,
  AuthShell,
} from "@/modules/identity-access/ui/auth-shell";
import { ChangePasswordForm } from "@/modules/identity-access/ui/change-password-form";

async function Content() {
  await requireSession("change-password"); // only reachable while a staff password change is required
  return (
    <ChangePasswordForm minLength={loadAuthConfig().staffPassword.minLength} />
  );
}

export default function ChangePasswordPage() {
  return (
    <AuthShell
      title="Choose a new password"
      description="Your password was issued or reset by an administrator. Set your own password to continue."
    >
      <Suspense fallback={<AuthLoading />}>
        <Content />
      </Suspense>
    </AuthShell>
  );
}
