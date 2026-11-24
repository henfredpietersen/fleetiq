import Link from "next/link";
import { Suspense } from "react";
import { buttonVariants } from "@/components/ui/button";
import {
  AuthLoading,
  AuthShell,
} from "@/modules/identity-access/ui/auth-shell";
import { requireSession } from "@/modules/identity-access/server/session";
import { ThisPhone } from "@/modules/drivers/ui/this-phone";

async function Content() {
  await requireSession("full");
  return <ThisPhone />;
}

export default function ThisPhonePage() {
  return (
    <AuthShell
      title="This phone"
      description="The code your administrator needs to register this phone."
    >
      <Suspense fallback={<AuthLoading />}>
        <Content />
      </Suspense>
      <Link
        href="/home"
        className={buttonVariants({
          variant: "outline",
          size: "lg",
          className: "min-h-12 w-full",
        })}
      >
        Back
      </Link>
    </AuthShell>
  );
}
