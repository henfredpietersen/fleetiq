import Link from "next/link";
import { Suspense } from "react";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { AppShell, Loading } from "@/components/app-shell";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { VoidInspection } from "@/modules/inspections-damage/ui/void-inspection";
import { requireSession } from "@/modules/identity-access/server/session";
import { uuidField } from "@/modules/fleet-vehicles/domain/vehicle-schema";
import { DEVICE_FLAG_LABEL } from "@/modules/drivers/domain/device-schema";
import {
  INSPECTION_STATUS_LABELS,
  RESPONSE_LABELS,
  stageLabel,
} from "@/modules/inspections-damage/domain/inspection-rules";
import { getInspectionDetail } from "@/modules/inspections-damage/server/inspection-service";
import { EvidencePhoto } from "@/modules/inspections-damage/ui/evidence-photo";
import {
  intervalText,
  NO_FAULT_NOTE,
} from "@/modules/inspections-damage/domain/damage-interval";
import {
  damageStatusLabel,
  severityLabel,
} from "@/modules/inspections-damage/domain/damage-zones";

const when = (iso: string | null) =>
  iso
    ? new Intl.DateTimeFormat("en-ZA", {
        timeZone: "Africa/Johannesburg",
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(iso))
    : "—";

type Params = Promise<{ id: string }>;

async function Content({ params }: { params: Params }) {
  const ctx = await requireSession("full");
  await connection();
  const { id } = await params;
  if (!uuidField.safeParse(id).success) notFound();
  const db = await createSupabaseServerClient();
  const r = await getInspectionDetail(db, id);
  if (!r.ok)
    return (
      <Alert variant="destructive">
        The inspection could not be loaded. {r.message}
      </Alert>
    );
  const d = r.detail;
  // the button only appears for people who can review exceptions in this branch; the database re-checks and logs every call
  const { data: canSeeLocation } = await db.rpc("has_permission", {
    permission_key: "odometer.exception.review",
    target_branch_id: d.branchId,
  });
  const { data: canManage } = await db.rpc("has_permission", {
    permission_key: "allocation.manage",
    target_branch_id: d.branchId,
  });
  const canVoid =
    canManage === true && d.status !== "void" && d.submittedBy !== ctx.userId;
  const photosOf = (itemId: string) =>
    d.itemPhotos.filter((p) => p.templateItemId === itemId);
  const defects = d.answers.filter((a) => a.value === "defect");
  const onBehalf = d.completedByRole === "supervisor_on_behalf";

  return (
    <>
      <div
        className="flex flex-wrap items-center gap-2"
        data-testid="inspection-badges"
      >
        <Badge variant="outline">
          {INSPECTION_STATUS_LABELS[d.status] ?? d.status}
        </Badge>
        {d.lateFlag ? <Badge variant="warning">Late</Badge> : null}
        {d.safetyDefectFlag ? (
          <Badge variant="destructive">Safety defect</Badge>
        ) : null}
        {d.capturedOffline ? (
          <Badge variant="outline">Captured offline</Badge>
        ) : null}
        {d.newDamageFlag ? (
          <Badge variant="warning" data-testid="new-damage-badge">
            New damage
          </Badge>
        ) : null}
        {onBehalf ? null : d.deviceFlag && d.deviceFlag !== "issued_device" ? (
          <Badge variant="warning" data-testid="device-flag">
            {DEVICE_FLAG_LABEL[d.deviceFlag] ?? d.deviceFlag}
          </Badge>
        ) : null}
        {!onBehalf && d.deviceFlag === "issued_device" ? (
          <Badge variant="success">{DEVICE_FLAG_LABEL.issued_device}</Badge>
        ) : null}
        {d.completedByRole === "supervisor_on_behalf" ? (
          <Badge variant="warning">Completed by supervisor</Badge>
        ) : null}
      </div>
      {onBehalf ? (
        <Alert
          className="border-amber-600/40 text-amber-800"
          data-testid="on-behalf-detail"
        >
          Completed on behalf of the driver by a supervisor — reason:{" "}
          {d.onBehalfReason}.{" "}
          <span data-testid="on-behalf-device-text">
            Completed by supervisor on their own phone.
          </span>
        </Alert>
      ) : null}
      {canVoid ? <VoidInspection inspectionId={d.id} /> : null}
      {d.status === "void" ? (
        <Alert>
          This inspection was voided{d.voidReason ? `: ${d.voidReason}` : "."}
        </Alert>
      ) : null}

      <section className="flex flex-col gap-1 text-sm" aria-label="Times">
        <p>Started (server): {when(d.startedAt)}</p>
        <p>Submitted (server): {when(d.submittedAt)}</p>
        <p className="text-muted-foreground">
          Phone time, not verified: started {when(d.deviceStartedAt)}, submitted{" "}
          {when(d.deviceSubmittedAt)}
        </p>
      </section>

      <section className="flex flex-col gap-2" aria-label="Answers">
        <h2 className="text-lg font-semibold">Answers</h2>
        {d.answers.length === 0 ? (
          <Alert>No answers have been saved yet.</Alert>
        ) : (
          <ol className="flex flex-col gap-2">
            {d.answers.map((a) => (
              <li
                key={a.templateItemId}
                className="rounded-lg border p-3"
                data-testid="answer-row"
              >
                <p className="font-medium">
                  {a.question}{" "}
                  {a.safetyCritical ? (
                    <Badge variant="outline">Safety</Badge>
                  ) : null}
                </p>
                <p>
                  {RESPONSE_LABELS[a.value] ?? a.value}
                  {a.comment ? ` — ${a.comment}` : ""}
                </p>
              </li>
            ))}
          </ol>
        )}
      </section>

      {defects.length > 0 ? (
        <section className="flex flex-col gap-3" aria-label="Defects">
          <h2 className="text-lg font-semibold">Defects and their photos</h2>
          {defects.map((a) => (
            <div key={a.templateItemId} className="flex flex-col gap-2">
              <p className="font-medium">
                {a.question}
                {a.comment ? ` — ${a.comment}` : ""}
              </p>
              {photosOf(a.templateItemId).length === 0 ? (
                <Alert>No photo is attached to this defect.</Alert>
              ) : (
                photosOf(a.templateItemId).map((p, n) => (
                  <EvidencePhoto
                    key={p.evidenceFileId}
                    evidenceFileId={p.evidenceFileId}
                    inspectionId={d.id}
                    label={`Defect photo ${n + 1}: ${a.question}`}
                    canSeeLocation={canSeeLocation === true}
                  />
                ))
              )}
            </div>
          ))}
        </section>
      ) : null}

      {d.newDamage.length > 0 ? (
        <section
          className="flex flex-col gap-3"
          aria-label="Damage reported in this inspection"
          data-testid="new-damage-section"
        >
          <h2 className="text-lg font-semibold">
            Damage reported in this inspection
          </h2>
          <p className="text-muted-foreground text-sm">{NO_FAULT_NOTE}</p>
          {d.newDamage.map((n) => (
            <div
              key={n.id}
              className="flex flex-col gap-2 rounded-lg border p-3"
              data-testid="new-damage-item"
            >
              <p className="flex flex-wrap items-center gap-2 font-medium">
                {n.zone_label}
                <Badge variant="outline">{severityLabel(n.severity)}</Badge>
                <Badge variant="outline">{damageStatusLabel(n.status)}</Badge>
              </p>
              <p>{n.description}</p>
              {intervalText(n.interval) ? (
                <p className="text-sm" data-testid="damage-interval">
                  {intervalText(n.interval)}
                </p>
              ) : null}
              {n.photo_ids.map((f, k) => (
                <EvidencePhoto
                  key={f}
                  evidenceFileId={f}
                  inspectionId={d.id}
                  label={`Damage photo ${k + 1}: ${n.zone_label}`}
                  canSeeLocation={canSeeLocation === true}
                />
              ))}
            </div>
          ))}
        </section>
      ) : null}

      <section className="flex flex-col gap-3" aria-label="Odometer photo">
        <h2 className="text-lg font-semibold">Odometer photo</h2>
        {d.odometerPhotos.length === 0 ? (
          <Alert>No odometer photo is attached.</Alert>
        ) : (
          d.odometerPhotos.map((p, n) => (
            <EvidencePhoto
              key={p.evidenceFileId}
              evidenceFileId={p.evidenceFileId}
              inspectionId={d.id}
              label={
                p.isCurrent
                  ? "Odometer photo (current)"
                  : `Odometer photo (earlier, ${d.odometerPhotos.length - n})`
              }
              current={p.isCurrent}
              canSeeLocation={canSeeLocation === true}
            />
          ))
        )}
      </section>
    </>
  );
}

export default function InspectionDetailPage({ params }: { params: Params }) {
  return (
    <AppShell
      title="Inspection"
      description="Read-only. Each photo is opened and logged one at a time; a photo's location is shown to reviewers only."
    >
      <Link
        href="/shifts/inspections"
        className={buttonVariants({ variant: "outline", className: "w-fit" })}
      >
        Back to inspections
      </Link>
      <Suspense fallback={<Loading label="Loading the inspection…" />}>
        <Content params={params} />
      </Suspense>
    </AppShell>
  );
}
