import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/database.types";
import type { Outcome } from "@/modules/fleet-vehicles/domain/action-state";
import { parseImportFile } from "../domain/csv-import";
import { serviceDbMessage } from "../domain/db-errors";
import {
  attachEvidenceSchema,
  changeDefaultSchema,
  decideOverrideSchema,
  overrideRequestSchema,
  parseInput,
  recordSchema,
  reverseSchema,
  stageImportSchema,
  verifySchema,
} from "../domain/service-schema";

// Every call runs as the SIGNED-IN USER (anon key + session): RLS and the SQL functions authorise, including
// DEC-24 (verifier <> creator, approver <> requester). No service-role key on this path. UI is never the boundary.
type Db = SupabaseClient<Database>;

const unavailable = {
  ok: false as const,
  message: "Something went wrong on our side. Please try again.",
};
/** Optional values travel as SQL NULL (the generated RPC types do not model nullable arguments). */
const nul = <T>(v: T | undefined): T => (v ?? null) as T;

export async function changeCompanyDefault(
  db: Db,
  raw: unknown,
): Promise<Outcome<{ id: string }>> {
  const p = parseInput(changeDefaultSchema, raw);
  if (!p.ok) return p;
  const v = p.value;
  const { data, error } = await db.rpc(
    "change_company_default_service_config",
    {
      p_interval_km: v.serviceIntervalKm,
      p_early_km: v.earlyToleranceKm,
      p_late_km: v.lateToleranceKm,
      p_interval_days: nul(v.serviceIntervalDays),
      p_early_days: nul(v.earlyToleranceDays),
      p_late_days: nul(v.lateToleranceDays),
      p_manufacturer_reference: nul(v.manufacturerReference),
      p_reason: v.reason,
    },
  );
  if (error) return { ok: false, message: serviceDbMessage(error) };
  if (!data) return unavailable;
  return { ok: true, id: data.id };
}

/** Requests an override. Nothing takes effect until a DIFFERENT service.config.manage holder approves (DEC-19, DEC-24). */
export async function requestOverride(
  db: Db,
  raw: unknown,
): Promise<Outcome<{ approvalId: string }>> {
  const p = parseInput(overrideRequestSchema, raw);
  if (!p.ok) return p;
  const v = p.value;
  const { data, error } = await db.rpc("request_service_config_override", {
    p_scope: v.scope,
    p_vehicle_id: nul(v.vehicleId),
    p_make: nul(v.make),
    p_model: nul(v.model),
    p_vehicle_category: nul(v.vehicleCategory),
    p_manufacturer_reference: nul(v.manufacturerReference),
    p_interval_km: v.serviceIntervalKm,
    p_early_km: v.earlyToleranceKm,
    p_late_km: v.lateToleranceKm,
    p_interval_days: nul(v.serviceIntervalDays),
    p_early_days: nul(v.earlyToleranceDays),
    p_late_days: nul(v.lateToleranceDays),
    p_reason: v.reason,
    p_client_submission_id: v.clientSubmissionId,
  });
  if (error) return { ok: false, message: serviceDbMessage(error) };
  if (!data) return unavailable;
  return { ok: true, approvalId: data.id };
}

export async function decideOverride(
  db: Db,
  raw: unknown,
): Promise<Outcome<{ decision: "approved" | "rejected" }>> {
  const p = parseInput(decideOverrideSchema, raw);
  if (!p.ok) return p;
  const v = p.value;
  const { error } = await db.rpc("decide_approval", {
    p_approval_id: v.approvalId,
    p_decision: v.decision,
    p_notes: nul(v.notes),
  });
  if (error) return { ok: false, message: serviceDbMessage(error) };
  return { ok: true, decision: v.decision };
}

export async function createRecord(
  db: Db,
  raw: unknown,
): Promise<Outcome<{ id: string }>> {
  const p = parseInput(recordSchema, raw);
  if (!p.ok) return p;
  const v = p.value;
  const { data, error } = await db.rpc("create_service_record", {
    p_vehicle_id: v.vehicleId,
    p_service_date: v.serviceDate,
    p_odometer_km: v.odometerKm,
    p_service_type: v.serviceType,
    p_source: v.source,
    p_supplier_name: nul(v.supplierName),
    p_job_reference: nul(v.jobReference),
    p_invoice_reference: nul(v.invoiceReference),
    p_labour_cost: nul(v.labourCost),
    p_parts_cost: nul(v.partsCost),
    p_total_cost: nul(v.totalCost),
    p_evidence_file_id: nul(v.evidenceFileId),
    p_client_submission_id: v.clientSubmissionId,
  });
  if (error) return { ok: false, message: serviceDbMessage(error) };
  if (!data) return unavailable;
  return { ok: true, id: data };
}

/** Verify or reject. The verifier is never the creator: enforced in SQL (function + CHECK), not here (DEC-24). */
export async function verifyRecord(
  db: Db,
  raw: unknown,
): Promise<Outcome<{ decision: "verified" | "rejected" }>> {
  const p = parseInput(verifySchema, raw);
  if (!p.ok) return p;
  const v = p.value;
  const { error } = await db.rpc("verify_service_record", {
    p_record_id: v.recordId,
    p_decision: v.decision,
    p_reason: nul(v.reason),
  });
  if (error) return { ok: false, message: serviceDbMessage(error) };
  return { ok: true, decision: v.decision };
}

export async function reverseVerification(
  db: Db,
  raw: unknown,
): Promise<Outcome<{ id: string }>> {
  const p = parseInput(reverseSchema, raw);
  if (!p.ok) return p;
  const { error } = await db.rpc("reverse_service_verification", {
    p_record_id: p.value.recordId,
    p_reason: p.value.reason,
  });
  if (error) return { ok: false, message: serviceDbMessage(error) };
  return { ok: true, id: p.value.recordId };
}

/** CSV text -> staged rows + the database's validation report. Creates no service records (DEC-20). */
export async function stageImport(
  db: Db,
  raw: unknown,
): Promise<Outcome<{ batchId: string }>> {
  const p = parseInput(stageImportSchema, raw);
  if (!p.ok) return p;
  const file = parseImportFile(p.value.csvText);
  if (!file.ok)
    return { ok: false, message: file.message, details: file.details };
  const { data, error } = await db.rpc("stage_service_import", {
    p_filename: p.value.filename,
    p_rows: file.rows as unknown as Json,
    p_client_submission_id: p.value.clientSubmissionId,
  });
  if (error) return { ok: false, message: serviceDbMessage(error) };
  if (!data) return unavailable;
  return { ok: true, batchId: data };
}

/** Attaches the evidence photo to a valid row: creates a `recorded` historical_import record (verified separately). */
export async function attachEvidence(
  db: Db,
  raw: unknown,
): Promise<Outcome<{ recordId: string; batchId: string }>> {
  const p = parseInput(attachEvidenceSchema, raw);
  if (!p.ok) return p;
  const v = p.value;
  const { data, error } = await db.rpc("attach_import_row_evidence", {
    p_row_id: v.rowId,
    p_evidence_file_id: v.evidenceFileId,
    p_client_submission_id: v.clientSubmissionId,
  });
  if (error) return { ok: false, message: serviceDbMessage(error) };
  if (!data) return unavailable;
  return { ok: true, recordId: data, batchId: v.batchId };
}
