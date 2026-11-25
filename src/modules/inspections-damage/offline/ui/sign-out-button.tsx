"use client";
// Sign out (DEC-43): allowed with unsent items after a warning. The queued items stay on this phone, under this profile, and
// are sent after this driver's next sign-in here — never under another person's session.
import { useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { signOutAction } from "@/modules/identity-access/server/actions";
import { ACTIVE_PROFILE_KEY } from "./sync-bar";
import { useSync } from "./sync-manager";

export const SIGN_OUT_WARNING = (n: number) =>
  `${n} ${n === 1 ? "item is" : "items are"} saved on this phone and not sent yet. If you sign out they stay on this phone and are sent after you next sign in here.`;

export function SignOutButton({ profileId }: { profileId: string }) {
  const { state } = useSync(profileId);
  const [warning, setWarning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const unsent = state.items.length;

  async function signOut() {
    setBusy(true);
    setError(null);
    try {
      try {
        localStorage.removeItem(ACTIVE_PROFILE_KEY);
      } catch {
        /* ignore */
      }
      await signOutAction();
    } catch (e) {
      // a redirect is how a successful sign-out ends; anything else is a failed call (no connection)
      if (e && typeof e === "object" && "digest" in e) throw e;
      setError(
        "Could not sign out: there is no connection. Try again when you have signal.",
      );
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {warning ? (
        <Alert
          className="border-amber-600/40 text-amber-800"
          role="alertdialog"
          data-testid="sign-out-warning"
        >
          {SIGN_OUT_WARNING(unsent)}
        </Alert>
      ) : null}
      {error ? (
        <Alert variant="destructive" role="alert">
          {error}
        </Alert>
      ) : null}
      {warning ? (
        <>
          <Button
            type="button"
            size="lg"
            className="w-full"
            disabled={busy}
            onClick={() => void signOut()}
          >
            Sign out anyway
          </Button>
          <Button
            type="button"
            variant="outline"
            size="lg"
            className="w-full"
            disabled={busy}
            onClick={() => setWarning(false)}
          >
            Stay signed in
          </Button>
        </>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="lg"
          className="w-full"
          disabled={busy || !state.ready}
          onClick={() => (unsent > 0 ? setWarning(true) : void signOut())}
        >
          Sign out
        </Button>
      )}
    </div>
  );
}
