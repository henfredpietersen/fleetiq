import { Suspense } from "react";
import { connection } from "next/server";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Alert } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { AppShell, Loading } from "@/components/app-shell";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireSession } from "@/modules/identity-access/server/session";
import { uuidField } from "@/modules/fleet-vehicles/domain/vehicle-schema";
import { getMyInspection } from "@/modules/inspections-damage/server/inspection-service";
import { InspectionForm } from "@/modules/inspections-damage/ui/inspection-form";
import { cameraNoticeAcknowledged } from "@/modules/evidence-storage/server/notice-query";

type Params = Promise<{ allocationId: string }>;

// DEC-09: the supervisor completes the POST-shift inspection on the driver's behalf. Same stepped form, with a permanent banner.
// my_inspection answers only the allocation's driver and the completer of an on-behalf post-shift inspection; anyone else gets not found.
async function Content({ params }: { params: Params }) {
  await requireSession("full");
  await connection();
  const { allocationId } = await params;
  if (!uuidField.safeParse(allocationId).success) notFound();
  const db = await createSupabaseServerClient();
  const r = await getMyInspection(db, { allocationId, stage: "post_shift" });
  if (!r.ok)
    return (
      <Alert variant="destructive">
        The inspection could not be loaded. {r.message}
      </Alert>
    );
  if (r.inspection.inspection?.completed_by_role !== "supervisor_on_behalf")
    return (
      <Alert>
        This post-shift inspection has not been started on the driver&apos;s
        behalf. Start it from the allocation board.
      </Alert>
    );
  return (
    <InspectionForm
      allocationId={allocationId}
      data={r.inspection}
      noticeAcknowledged={await cameraNoticeAcknowledged(db)}
      mode="on_behalf"
    />
  );
}

export default function OnBehalfPage({ params }: { params: Params }) {
  return (
    <AppShell
      title="Post-shift inspection on the driver's behalf"
      description="You are completing this for the driver. Answer every item and take the photos with your phone camera."
    >
      <Link
        href="/shifts/allocations"
        className={buttonVariants({ variant: "outline", className: "w-fit" })}
      >
        Back to allocations
      </Link>
      <Suspense fallback={<Loading label="Loading the inspection…" />}>
        <Content params={params} />
      </Suspense>
    </AppShell>
  );
}
