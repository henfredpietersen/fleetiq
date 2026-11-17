import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import type { ListFilters } from "../domain/vehicle-schema";

// Read paths. RLS scopes every query to the company and to branches the user holds a role on.
type Db = SupabaseClient<Database>;

export type BranchOption = { id: string; name: string; branchCode: string };

export async function listBranches(db: Db) {
  const { data, error } = await db
    .from("branches")
    .select("id, name, branch_code")
    .eq("status", "active")
    .order("name");
  if (error) return { ok: false as const };
  const branches: BranchOption[] = (data ?? []).map((b) => ({
    id: b.id,
    name: b.name,
    branchCode: b.branch_code,
  }));
  return { ok: true as const, branches };
}

/** Branches where the user holds vehicle.manage — decided by the same has_permission() RLS uses. */
export async function manageableBranchIds(
  db: Db,
  branches: BranchOption[],
): Promise<Set<string>> {
  const checks = await Promise.all(
    branches.map(async (b) => {
      const { data } = await db.rpc("has_permission", {
        permission_key: "vehicle.manage",
        target_branch_id: b.id,
      });
      return data === true ? b.id : null;
    }),
  );
  return new Set(checks.filter((id): id is string => id !== null));
}

const LIST_COLUMNS =
  "id, fleet_number, registration_number, make, model, vehicle_category, administrative_status, current_branch_id, current_odometer_km, archived_at";

export async function listVehicles(db: Db, f: ListFilters) {
  let q = db
    .from("vehicles")
    .select(LIST_COLUMNS)
    .order("fleet_number")
    .limit(500);
  if (f.branchId) q = q.eq("current_branch_id", f.branchId);
  if (f.status) q = q.eq("administrative_status", f.status);
  if (f.archived === "active") q = q.is("archived_at", null);
  if (f.archived === "archived") q = q.not("archived_at", "is", null);
  if (f.q) {
    const t = `%${f.q}%`;
    q = q.or(
      `registration_number.ilike.${t},fleet_number.ilike.${t},make.ilike.${t},model.ilike.${t}`,
    );
  }
  const { data, error } = await q;
  if (error) return { ok: false as const };
  return { ok: true as const, vehicles: data ?? [] };
}

export async function getVehicle(db: Db, id: string) {
  const { data: vehicle, error } = await db
    .from("vehicles")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) return { ok: false as const, reason: "error" as const };
  if (!vehicle) return { ok: false as const, reason: "not_found" as const };

  const [history, pending] = await Promise.all([
    db
      .from("vehicle_branch_assignments")
      .select("id, branch_id, effective_from, effective_to, approval_id")
      .eq("vehicle_id", id)
      .order("effective_from", { ascending: false }),
    db
      .from("approvals")
      .select("id, requested_by, reason, payload, created_at")
      .eq("approval_type", "branch_transfer")
      .eq("entity_id", id)
      .eq("status", "pending"),
  ]);
  return {
    ok: true as const,
    vehicle,
    history: history.data ?? [],
    historyFailed: history.error !== null,
    pendingTransfer: pending.data?.[0] ?? null,
  };
}

export type PendingTransfer = {
  id: string;
  requestedByMe: boolean;
  reason: string | null;
  createdAt: string;
  vehicleId: string;
  vehicleLabel: string;
  fromBranchId: string | null;
  toBranchId: string | null;
};

/** Pending branch transfers the user may see: their own requests, or ones they can decide (RLS). */
export async function listPendingTransfers(db: Db, userId: string) {
  const { data, error } = await db
    .from("approvals")
    .select("id, entity_id, requested_by, reason, payload, created_at")
    .eq("approval_type", "branch_transfer")
    .eq("status", "pending")
    .order("created_at");
  if (error) return { ok: false as const };
  const rows = data ?? [];
  const ids = [...new Set(rows.map((r) => r.entity_id))];
  const labels = new Map<string, string>();
  if (ids.length > 0) {
    const { data: vs } = await db
      .from("vehicles")
      .select("id, fleet_number, registration_number")
      .in("id", ids);
    for (const v of vs ?? [])
      labels.set(v.id, `${v.registration_number} · ${v.fleet_number}`);
  }
  const transfers: PendingTransfer[] = rows.map((r) => {
    const payload = (r.payload ?? {}) as {
      from_branch_id?: string;
      to_branch_id?: string;
    };
    return {
      id: r.id,
      requestedByMe: r.requested_by === userId,
      reason: r.reason,
      createdAt: r.created_at,
      vehicleId: r.entity_id,
      vehicleLabel: labels.get(r.entity_id) ?? "Vehicle",
      fromBranchId: payload.from_branch_id ?? null,
      toBranchId: payload.to_branch_id ?? null,
    };
  });
  return { ok: true as const, transfers };
}
