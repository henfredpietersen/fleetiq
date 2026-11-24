import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import type { Outcome } from "@/modules/fleet-vehicles/domain/action-state";
import { inspectionDbMessage } from "../domain/inspection-errors";
import {
  onboardingDamageSchema,
  parseInput,
  repairDamageSchema,
  reportDamageSchema,
  reviewDamageSchema,
} from "../domain/damage-schema";
import { zoneLabel } from "../domain/damage-zones";
import type { DamageRegisterItem } from "../domain/inspection-types";

// Damage register services (DEC-42). Every call runs as the SIGNED-IN USER: the SQL functions authorise and re-check every rule
// (who may report, review or repair; never your own report, DEC-24) — the UI hides actions but is never the boundary. zod first;
// blanks become NULL. Idempotent: the caller sends the same clientSubmissionId on every retry (DEC-06).
type Db = SupabaseClient<Database>;
const nul = <T>(v: T | undefined): T => (v ?? null) as T;
const unavailable = {
  ok: false as const,
  message: "Something went wrong on our side. Please try again.",
};

export async function reportDamage(
  db: Db,
  raw: unknown,
): Promise<Outcome<{ damageId: string }>> {
  const p = parseInput(reportDamageSchema, raw);
  if (!p.ok) return p;
  const { data, error } = await db.rpc("report_damage", {
    p_inspection_id: p.value.inspectionId,
    p_zone: p.value.zone,
    p_severity: p.value.severity,
    p_description: p.value.description,
    p_evidence_file_ids: p.value.evidenceFileIds,
    p_device_reported_at: nul<string>(p.value.deviceReportedAt),
    p_captured_offline: p.value.capturedOffline,
    p_client_submission_id: p.value.clientSubmissionId,
  });
  if (error) return { ok: false, message: inspectionDbMessage(error) };
  if (!data) return unavailable;
  return { ok: true, damageId: data };
}

/** Day-one load: a holder of allocation.manage records a vehicle's existing damage (source 'onboarding'). */
export async function recordOnboardingDamage(
  db: Db,
  raw: unknown,
): Promise<Outcome<{ damageId: string }>> {
  const p = parseInput(onboardingDamageSchema, raw);
  if (!p.ok) return p;
  const { data, error } = await db.rpc("record_onboarding_damage", {
    p_vehicle_id: p.value.vehicleId,
    p_zone: p.value.zone,
    p_severity: p.value.severity,
    p_description: p.value.description,
    p_evidence_file_ids: p.value.evidenceFileIds,
    p_client_submission_id: p.value.clientSubmissionId,
  });
  if (error) return { ok: false, message: inspectionDbMessage(error) };
  if (!data) return unavailable;
  return { ok: true, damageId: data };
}

export async function reviewDamage(
  db: Db,
  raw: unknown,
): Promise<Outcome<{ damageId: string }>> {
  const p = parseInput(reviewDamageSchema, raw);
  if (!p.ok) return p;
  const { data, error } = await db.rpc("review_damage", {
    p_item_id: p.value.itemId,
    p_decision: p.value.decision,
    p_reason: nul<string>(p.value.reason),
    p_client_submission_id: p.value.clientSubmissionId,
  });
  if (error) return { ok: false, message: inspectionDbMessage(error) };
  if (!data) return unavailable;
  return { ok: true, damageId: data };
}

export async function markDamageRepaired(
  db: Db,
  raw: unknown,
): Promise<Outcome<{ damageId: string }>> {
  const p = parseInput(repairDamageSchema, raw);
  if (!p.ok) return p;
  const { data, error } = await db.rpc("mark_damage_repaired", {
    p_item_id: p.value.itemId,
    p_note: p.value.note,
    p_client_submission_id: p.value.clientSubmissionId,
  });
  if (error) return { ok: false, message: inspectionDbMessage(error) };
  if (!data) return unavailable;
  return { ok: true, damageId: data };
}

/**
 * The vehicle's damage register as the signed-in user may read it (RLS: allocation.manage / reports.view for the branch). Names are
 * never read (DEC-37/41): only whether the item is the caller's own. Photos are listed by id; each is a separate logged signed-URL request.
 */
export async function listVehicleDamage(
  db: Db,
  vehicleId: string,
  userId: string,
): Promise<Outcome<{ items: DamageRegisterItem[] }>> {
  const { data, error } = await db
    .from("vehicle_damage_items")
    .select(
      "id, zone, severity, description, status, source, reported_at, reported_by, reviewed_at, review_reason, repaired_at, repair_note, vehicle_damage_evidence(evidence_file_id, added_at)",
    )
    .eq("vehicle_id", vehicleId)
    .order("reported_at", { ascending: false })
    .limit(500);
  if (error) return { ok: false, message: inspectionDbMessage(error) };
  return {
    ok: true,
    items: (data ?? []).map((d) => ({
      id: d.id,
      zone: d.zone,
      zoneLabel: zoneLabel(d.zone),
      severity: d.severity,
      description: d.description,
      status: d.status,
      source: d.source,
      reportedAt: d.reported_at,
      reportedByMe: d.reported_by === userId,
      reviewedAt: d.reviewed_at,
      reviewReason: d.review_reason,
      repairedAt: d.repaired_at,
      repairNote: d.repair_note,
      photoIds: [...(d.vehicle_damage_evidence ?? [])]
        .sort((a, b) => a.added_at.localeCompare(b.added_at))
        .map((e) => e.evidence_file_id),
    })),
  };
}
