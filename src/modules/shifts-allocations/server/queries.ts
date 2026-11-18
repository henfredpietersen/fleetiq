import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { localDate } from "../domain/shift-times";

// Read paths, as the signed-in user. RLS scopes every query to the branches the caller may manage or view reports for.
type Db = SupabaseClient<Database>;

export type ShiftBranch = {
  id: string;
  name: string;
  canManage: boolean;
  canView: boolean;
};

/** The caller's branches with their rights (shift_access()). Drives the screens and the navigation entry. */
export async function getShiftAccess(db: Db) {
  const { data, error } = await db.rpc("shift_access");
  if (error) return { ok: false as const };
  const branches: ShiftBranch[] = (data ?? []).map((r) => ({
    id: r.branch_id,
    name: r.branch_name,
    canManage: r.can_manage,
    canView: r.can_view,
  }));
  return { ok: true as const, branches };
}

export async function listTemplates(
  db: Db,
  branchId: string,
  includeArchived: boolean,
) {
  let q = db
    .from("shift_templates")
    .select("*")
    .eq("branch_id", branchId)
    .order("status")
    .order("start_time")
    .order("name")
    .limit(200);
  if (!includeArchived) q = q.eq("status", "active");
  const { data, error } = await q;
  if (error) return { ok: false as const };
  return { ok: true as const, templates: data ?? [] };
}

export type ShiftFilter = { branchId: string; from: string; to: string };

export async function listShifts(db: Db, f: ShiftFilter) {
  const { data, error } = await db
    .from("shifts")
    .select("*")
    .eq("branch_id", f.branchId)
    .gte("shift_date", f.from)
    .lte("shift_date", f.to)
    .order("shift_date")
    .order("scheduled_start_at")
    .limit(500);
  if (error) return { ok: false as const };
  return { ok: true as const, shifts: data ?? [] };
}

/** Active departments a shift at this branch may use: company-wide ones and the branch's own. */
export async function listDepartments(db: Db, branchId: string) {
  const { data, error } = await db
    .from("departments")
    .select("id, name, branch_id")
    .eq("status", "active")
    .or(`branch_id.is.null,branch_id.eq.${branchId}`)
    .order("name")
    .limit(200);
  if (error) return { ok: false as const };
  return { ok: true as const, departments: data ?? [] };
}

/** Default list window: today and the next 13 days (Africa/Johannesburg). */
export function defaultRange(now: Date = new Date()): {
  from: string;
  to: string;
} {
  const from = localDate(now);
  const to = new Date(`${from}T00:00:00Z`);
  to.setUTCDate(to.getUTCDate() + 13);
  return { from, to: to.toISOString().slice(0, 10) };
}
