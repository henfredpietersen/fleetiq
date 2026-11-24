import { Suspense } from "react";
import { connection } from "next/server";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Alert } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import {
  AuthLoading,
  AuthShell,
} from "@/modules/identity-access/ui/auth-shell";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireSession } from "@/modules/identity-access/server/session";
import { uuidField } from "@/modules/fleet-vehicles/domain/vehicle-schema";
import { stageFromSlug } from "@/modules/inspections-damage/domain/inspection-rules";
import { getMyInspection } from "@/modules/inspections-damage/server/inspection-service";
import { InspectionForm } from "@/modules/inspections-damage/ui/inspection-form";

type Params = Promise<{ allocationId: string; stage: string }>;

async function Content({ params }: { params: Params }) {
  await requireSession("full");
  await connection();
  const { allocationId, stage: slug } = await params;
  const stage = stageFromSlug(slug);
  if (!stage || !uuidField.safeParse(allocationId).success) notFound();
  const db = await createSupabaseServerClient();
  const r = await getMyInspection(db, { allocationId, stage });
  if (!r.ok)
    return (
      <div className="flex flex-col gap-3">
        <Alert variant="destructive">
          The inspection could not be loaded. {r.message}
        </Alert>
        <Link
          href={`/my-allocations/${allocationId}/inspection/${slug}`}
          className={buttonVariants({
            size: "lg",
            className: "min-h-14 w-full",
          })}
        >
          Try again
        </Link>
      </div>
    );
  return <InspectionForm allocationId={allocationId} data={r.inspection} />;
}

export default function InspectionPage({ params }: { params: Params }) {
  return (
    <AuthShell
      title="Inspection"
      description="Answer every item. Photos are added with the camera in the next update."
    >
      <Suspense fallback={<AuthLoading />}>
        <Content params={params} />
      </Suspense>
      <Link
        href="/my-allocations"
        className={buttonVariants({
          variant: "outline",
          size: "lg",
          className: "min-h-12 w-full",
        })}
      >
        Back to my allocations
      </Link>
    </AuthShell>
  );
}
