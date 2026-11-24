"use client";

import { useEffect, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { deviceShortCode } from "@/modules/evidence-storage/domain/device-key";
import { getDeviceKey } from "@/modules/evidence-storage/ui/device-key";

/** "This phone" (DEC-35): the code the administrator enters to register the phone. It identifies this app install only. */
export function ThisPhone() {
  const [key, setKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    void getDeviceKey().then(setKey);
  }, []);
  if (!key) return <p role="status">Loading…</p>;
  return (
    <div className="flex flex-col gap-4" data-testid="this-phone">
      <div>
        <p className="text-muted-foreground text-sm">Short code</p>
        <p
          className="font-mono text-3xl font-semibold"
          data-testid="short-code"
        >
          {deviceShortCode(key)}
        </p>
      </div>
      <div>
        <p className="text-muted-foreground text-sm">
          Full code (give this to your administrator)
        </p>
        <p className="font-mono text-sm break-all" data-testid="full-code">
          {key}
        </p>
      </div>
      <Button
        type="button"
        size="lg"
        className="min-h-14 w-full text-base"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(key);
            setCopied(true);
          } catch {
            setCopied(false);
          }
        }}
      >
        {copied ? "Copied" : "Copy the full code"}
      </Button>
      <Alert>
        This code identifies the app on this phone, not the phone itself. It is
        only used to note which phone an inspection was made on. Using another
        phone is flagged for your supervisor; it never stops you doing an
        inspection.
      </Alert>
    </div>
  );
}
