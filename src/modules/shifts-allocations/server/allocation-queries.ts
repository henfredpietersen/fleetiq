import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";

// Read paths, as the signed-in user. RLS scopes every query: allocation.manage or reports.view for the branch (and a
// driver's own rows). Names come from the vehicle register and the driver register views, which apply their own rules.
type Db = SupabaseClient<Database>;

export type BoardAllocation = {
  id: string;
  shiftId: string;
  vehicleLabel: string;
  driverLabel: string;
  plannedStartAt: string;
  plannedEndAt: string;
  status: string;
  licenceClassCheck: string;
};

const unique = (ids: string[]) => [...new Set(ids)];

/** The branch's shifts on one local date with their allocations. */
export async function getBoard(db: Db, branchId: string, date: string) {
  const { data: shifts, error } = await db
    .from("shifts")
    .select("id, scheduled_start_at, scheduled_end_at, status, shift_date")
    .eq("branch_id", branchId)
    .eq("shift_date", date)
    .order("scheduled_start_at")
    .limit(100);
  if (error) return { ok: false as const };
  const ids = (shifts ?? []).map((s) => s.id);
  if (ids.length === 0)
    return {
      ok: true as const,
      shifts: [] as NonNullable<typeof shifts>,
      allocations: [] as BoardAllocation[],
    };
  const { data: rows, error: e2 } = await db
    .from("vehicle_allocations")
    .select(
      "id, shift_id, vehicle_id, driver_id, planned_start_at, planned_end_at, status, licence_class_check",
    )
    .in("shift_id", ids)
    .order("planned_start_at")
    .limit(500);
  if (e2) return { ok: false as const };
  const allocs = rows ?? [];
  const [veh, drv] = await Promise.all([
    allocs.length
      ? db
          .from("vehicles")
          .select("id, fleet_number, registration_number")
          .in("id", unique(allocs.map((a) => a.vehicle_id)))
      : Promise.resolve({ data: [], error: null }),
    allocs.length
      ? db
          .from("driver_register")
          .select("id, display_name, employee_number")
          .in("id", unique(allocs.map((a) => a.driver_id)))
      : Promise.resolve({ data: [], error: null }),
  ]);
  const vName = new Map(
    (veh.data ?? []).map((v) => [
      v.id,
      `${v.fleet_number} · ${v.registration_number}`,
    ]),
  );
  const dName = new Map(
    (drv.data ?? []).map((d) => [
      d.id ?? "",
      `${d.display_name ?? "Driver"} (${d.employee_number ?? "—"})`,
    ]),
  );
  const allocations: BoardAllocation[] = allocs.map((a) => ({
    id: a.id,
    shiftId: a.shift_id,
    vehicleLabel: vName.get(a.vehicle_id) ?? "Vehicle",
    driverLabel: dName.get(a.driver_id) ?? "Driver",
    plannedStartAt: a.planned_start_at,
    plannedEndAt: a.planned_end_at,
    status: a.status,
    licenceClassCheck: a.licence_class_check,
  }));
  return { ok: true as const, shifts: shifts ?? [], allocations };
}

/** Vehicles that can be allocated at the branch (available, not archived) and its active drivers. */
export async function getAllocatable(db: Db, branchId: string) {
  const [v, d] = await Promise.all([
    db
      .from("vehicles")
      .select("id, fleet_number, registration_number, required_licence_code")
      .eq("current_branch_id", branchId)
      .eq("administrative_status", "available")
      .is("archived_at", null)
      .order("fleet_number")
      .limit(500),
    db
      .from("driver_register")
      .select("id, display_name, employee_number")
      .eq("branch_id", branchId)
      .eq("active_status", "active")
      .order("display_name")
      .limit(500),
  ]);
  if (v.error || d.error) return { ok: false as const };
  return {
    ok: true as const,
    vehicles: (v.data ?? []).map((x) => ({
      id: x.id,
      label: `${x.fleet_number} · ${x.registration_number}${x.required_licence_code ? ` (needs ${x.required_licence_code})` : ""}`,
    })),
    drivers: (d.data ?? []).flatMap((x) =>
      x.id
        ? [
            {
              id: x.id,
              label: `${x.display_name ?? "Driver"} (${x.employee_number ?? "—"})`,
            },
          ]
        : [],
    ),
  };
}

export type PendingOverride = {
  id: string;
  requestedBy: string;
  requesterName: string;
  reason: string;
  createdAt: string;
  vehicleLabel: string;
  driverLabel: string;
  driverProfileId: string | null;
  shiftLabel: string;
};

/** Pending licence overrides the caller may see (allocation.manage for the branch, or their own requests). */
export async function listPendingOverrides(db: Db) {
  const { data, error } = await db
    .from("approvals")
    .select("id, requested_by, reason, created_at, payload")
    .eq("approval_type", "licence_override")
    .eq("status", "pending")
    .order("created_at")
    .limit(200);
  if (error) return { ok: false as const };
  const rows = data ?? [];
  const pl = (r: (typeof rows)[number]) =>
    (r.payload ?? {}) as Record<string, string>;
  const vIds = unique(rows.map((r) => pl(r).vehicle_id).filter(Boolean));
  const dIds = unique(rows.map((r) => pl(r).driver_id).filter(Boolean));
  const sIds = unique(rows.map((r) => pl(r).shift_id).filter(Boolean));
  const rIds = unique(rows.map((r) => r.requested_by));
  const [veh, drv, drvProfiles, shifts, req] = await Promise.all([
    vIds.length
      ? db
          .from("vehicles")
          .select("id, fleet_number, registration_number")
          .in("id", vIds)
      : Promise.resolve({ data: [] }),
    dIds.length
      ? db
          .from("driver_register")
          .select("id, display_name, employee_number")
          .in("id", dIds)
      : Promise.resolve({ data: [] }),
    dIds.length
      ? db.from("drivers").select("id, profile_id").in("id", dIds)
      : Promise.resolve({ data: [] }),
    sIds.length
      ? db
          .from("shifts")
          .select("id, shift_date, scheduled_start_at, scheduled_end_at")
          .in("id", sIds)
      : Promise.resolve({ data: [] }),
    rIds.length
      ? db.from("profiles").select("id, display_name").in("id", rIds)
      : Promise.resolve({ data: [] }),
  ]);
  const vName = new Map(
    (veh.data ?? []).map((v) => [
      v.id,
      `${v.fleet_number} · ${v.registration_number}`,
    ]),
  );
  const dName = new Map(
    (drv.data ?? []).map((d) => [
      d.id ?? "",
      `${d.display_name ?? "Driver"} (${d.employee_number ?? "—"})`,
    ]),
  );
  const dProfile = new Map(
    (drvProfiles.data ?? []).map((d) => [d.id, d.profile_id]),
  );
  const sLabel = new Map(
    (shifts.data ?? []).map((s) => [
      s.id,
      `${s.shift_date}|${s.scheduled_start_at}|${s.scheduled_end_at}`,
    ]),
  );
  const rName = new Map((req.data ?? []).map((r) => [r.id, r.display_name]));
  const overrides: PendingOverride[] = rows.map((r) => ({
    id: r.id,
    requestedBy: r.requested_by,
    requesterName: rName.get(r.requested_by) ?? "Another user",
    reason: r.reason ?? "",
    createdAt: r.created_at,
    vehicleLabel: vName.get(pl(r).vehicle_id) ?? "Vehicle",
    driverLabel: dName.get(pl(r).driver_id) ?? "Driver",
    driverProfileId: dProfile.get(pl(r).driver_id) ?? null,
    shiftLabel: sLabel.get(pl(r).shift_id) ?? "",
  }));
  return { ok: true as const, overrides };
}
