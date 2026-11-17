import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";

// Read paths, as the signed-in user. RLS scopes every query; the derived status comes from the
// security_invoker view vehicle_service_status (never raw records, which most staff cannot read).
type Db = SupabaseClient<Database>;

export async function hasPermission(
  db: Db,
  key: string,
  branchId: string | null,
): Promise<boolean> {
  const { data } = await db.rpc("has_permission", {
    permission_key: key,
    target_branch_id: branchId as string, // nullable in SQL; generated type is non-null
  });
  return data === true;
}

export async function getVehicleServiceStatus(db: Db, vehicleId: string) {
  const { data, error } = await db
    .from("vehicle_service_status")
    .select("*")
    .eq("vehicle_id", vehicleId)
    .maybeSingle();
  if (error) return { ok: false as const };
  return { ok: true as const, status: data };
}

export async function listConfigs(db: Db) {
  const { data, error } = await db
    .from("vehicle_service_configs")
    .select("*")
    .order("scope")
    .order("effective_from", { ascending: false })
    .limit(500);
  if (error) return { ok: false as const };
  return { ok: true as const, configs: data ?? [] };
}

export type OverrideRequest = {
  id: string;
  status: string;
  requestedByMe: boolean;
  reason: string | null;
  decisionNotes: string | null;
  createdAt: string;
  decidedAt: string | null;
  payload: Record<string, unknown>;
};

/** Requests the user may see (RLS: their own, or ones they may decide), newest first. */
export async function listOverrideRequests(db: Db, userId: string) {
  const { data, error } = await db
    .from("approvals")
    .select(
      "id, status, requested_by, reason, decision_notes, created_at, decided_at, payload",
    )
    .eq("approval_type", "service_config_override")
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) return { ok: false as const };
  const requests: OverrideRequest[] = (data ?? []).map((r) => ({
    id: r.id,
    status: r.status,
    requestedByMe: r.requested_by === userId,
    reason: r.reason,
    decisionNotes: r.decision_notes,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
    payload: (r.payload ?? {}) as Record<string, unknown>,
  }));
  return { ok: true as const, requests };
}

export type VehicleOption = {
  id: string;
  label: string;
  make: string;
  model: string;
  vehicleCategory: string;
  branchId: string;
};

export async function listVehicleOptions(db: Db) {
  const { data, error } = await db
    .from("vehicles")
    .select(
      "id, registration_number, fleet_number, make, model, vehicle_category, current_branch_id",
    )
    .is("archived_at", null)
    .order("registration_number")
    .limit(500);
  if (error) return { ok: false as const };
  const vehicles: VehicleOption[] = (data ?? []).map((v) => ({
    id: v.id,
    label: `${v.registration_number} · ${v.fleet_number}`,
    make: v.make,
    model: v.model,
    vehicleCategory: v.vehicle_category,
    branchId: v.current_branch_id,
  }));
  return { ok: true as const, vehicles };
}

const RECORD_COLUMNS =
  "id, vehicle_id, branch_id, service_date, actual_service_odometer_km, service_type, source, supplier_name, job_reference, invoice_reference, evidence_file_id, verification_status, created_by, created_at, verified_by, verified_at, rejected_at, rejection_reason";

export async function listRecords(
  db: Db,
  status: "recorded" | "verified" | "rejected",
  limit = 100,
) {
  const { data, error } = await db
    .from("service_records")
    .select(RECORD_COLUMNS)
    .eq("verification_status", status)
    .order("created_at", { ascending: status === "recorded" })
    .limit(limit);
  if (error) return { ok: false as const };
  const rows = data ?? [];
  const ids = [...new Set(rows.map((r) => r.vehicle_id))];
  const labels = new Map<string, string>();
  if (ids.length > 0) {
    const { data: vs } = await db
      .from("vehicles")
      .select("id, registration_number, fleet_number")
      .in("id", ids);
    for (const v of vs ?? [])
      labels.set(v.id, `${v.registration_number} · ${v.fleet_number}`);
  }
  return {
    ok: true as const,
    records: rows.map((r) => ({
      ...r,
      vehicleLabel: labels.get(r.vehicle_id) ?? "Vehicle",
    })),
  };
}

export async function listImportBatches(db: Db) {
  const { data, error } = await db
    .from("service_import_batches")
    .select("id, filename, created_at, created_by")
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) return { ok: false as const };
  return { ok: true as const, batches: data ?? [] };
}

export async function getImportBatch(db: Db, batchId: string) {
  const { data: batch, error } = await db
    .from("service_import_batches")
    .select("id, filename, created_at, created_by")
    .eq("id", batchId)
    .maybeSingle();
  if (error) return { ok: false as const, reason: "error" as const };
  if (!batch) return { ok: false as const, reason: "not_found" as const };
  const { data: rows, error: rowsError } = await db
    .from("service_import_rows")
    .select(
      "id, row_number, registration_number, service_date_raw, odometer_raw, service_type, supplier_name, job_reference, invoice_reference, vehicle_id, row_status, errors, service_record_id",
    )
    .eq("batch_id", batchId)
    .order("row_number")
    .limit(500);
  if (rowsError) return { ok: false as const, reason: "error" as const };
  return { ok: true as const, batch, rows: rows ?? [] };
}
