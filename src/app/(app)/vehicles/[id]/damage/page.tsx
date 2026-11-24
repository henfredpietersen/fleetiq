import Link from "next/link";
import { Suspense } from "react";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { Alert } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { AppShell, Loading } from "@/components/app-shell";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireSession } from "@/modules/identity-access/server/session";
import { uuidField } from "@/modules/fleet-vehicles/domain/vehicle-schema";
import { cameraNoticeAcknowledged } from "@/modules/evidence-storage/server/notice-query";
import { listVehicleDamage } from "@/modules/inspections-damage/server/damage-service";
import {
  DamageRegister,
  RecordExistingDamage,
} from "@/modules/inspections-damage/ui/damage-register";

type Params = Promise<{ id: string }>;

async function Content({ params }: { params: Params }) {
  const ctx = await requireSession("full");
  await connection();
  const { id } = await params;
  if (!uuidField.safeParse(id).success) notFound();
  const db = await createSupabaseServerClient();
  const { data: v } = await db
    .from("vehicles")
    .select("registration_number, fleet_number, current_branch_id")
    .eq("id", id)
    .maybeSingle();
  if (!v)
    return (
      <Alert>
        This vehicle was not found, or it is not in a branch you have access to.
      </Alert>
    );
  const r = await listVehicleDamage(db, id, ctx.userId);
  if (!r.ok)
    return (
      <Alert variant="destructive">
        The damage register could not be loaded. {r.message}
      </Alert>
    );
  // the buttons only appear for people who may use them; the database re-checks every call (and refuses your own reports)
  const [review, repair] = await Promise.all([
    db.rpc("has_permission", {
      permission_key: "allocation.manage",
      target_branch_id: v.current_branch_id,
    }),
    db.rpc("has_permission", {
      permission_key: "service.record.create",
      target_branch_id: v.current_branch_id,
    }),
  ]);
  const canReview = review.data === true;
  return (
    <>
      <p className="text-muted-foreground text-sm">
        {v.fleet_number} · {v.registration_number}. Damage is recorded when it
        is first reported. It does not say who caused it.
      </p>
      {canReview ? (
        <RecordExistingDamage
          vehicleId={id}
          noticeAcknowledged={await cameraNoticeAcknowledged(db)}
        />
      ) : null}
      <DamageRegister
        items={r.items}
        canReview={canReview}
        canRepair={repair.data === true}
      />
    </>
  );
}

export default function VehicleDamagePage({ params }: { params: Params }) {
  return (
    <AppShell
      title="Damage register"
      description="Known damage on this vehicle, with photos and status history."
    >
      <Link
        href="/vehicles"
        className={buttonVariants({ variant: "outline", className: "w-fit" })}
      >
        Back to vehicles
      </Link>
      <Suspense fallback={<Loading label="Loading the damage register…" />}>
        <Content params={params} />
      </Suspense>
    </AppShell>
  );
}
