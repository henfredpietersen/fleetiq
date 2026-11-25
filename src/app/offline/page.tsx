import { AuthShell } from "@/modules/identity-access/ui/auth-shell";
import { OfflineDriverApp } from "@/modules/inspections-damage/offline/ui/offline-app";

// The offline shell (ARCH §6.9): a static page the service worker serves when a driver screen cannot be reached. It holds NO data:
// it draws the allocations and inspection forms from the phone's own storage (the 24-hour snapshot + the unsent queue).
export default function OfflinePage() {
  return (
    <AuthShell
      title="Working offline"
      description="What is saved on this phone. Everything you do here is sent when you have a connection again."
    >
      <OfflineDriverApp />
    </AuthShell>
  );
}
