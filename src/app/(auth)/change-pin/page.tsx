import { Suspense } from "react";
import { loadAuthConfig } from "@/modules/identity-access/domain/auth-config";
import { requireSession } from "@/modules/identity-access/server/session";
import {
  AuthLoading,
  AuthShell,
} from "@/modules/identity-access/ui/auth-shell";
import { ChangePinForm } from "@/modules/identity-access/ui/change-pin-form";

async function Content() {
  await requireSession("change-pin"); // only reachable while a PIN change is required
  return <ChangePinForm pinLength={loadAuthConfig().pin.length} />;
}

export default function ChangePinPage() {
  return (
    <AuthShell
      title="Choose a new PIN"
      description="Your PIN was issued or reset. Set your own PIN to continue."
    >
      <Suspense fallback={<AuthLoading />}>
        <Content />
      </Suspense>
    </AuthShell>
  );
}
