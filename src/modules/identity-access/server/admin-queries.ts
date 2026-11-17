import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";

// Read paths for the staff-user screens. They run as the signed-in user: RLS shows other people's profiles and
// grants only to users.roles.manage holders, so an unauthorised caller simply gets nothing.
type Db = SupabaseClient<Database>;

export async function canManageUsers(db: Db): Promise<boolean> {
  const { data } = await db.rpc("has_permission", {
    permission_key: "users.roles.manage",
    target_branch_id: null as unknown as string, // null = company-wide (generated type is non-nullable)
  });
  return data === true;
}

export type StaffRow = {
  id: string;
  displayName: string;
  email: string | null;
  status: string;
  passwordChangePending: boolean;
  activeRoles: string[];
};

export async function listStaff(
  db: Db,
): Promise<{ ok: true; staff: StaffRow[] } | { ok: false }> {
  const nowIso = new Date().toISOString();
  const [profiles, grants] = await Promise.all([
    db
      .from("profiles")
      .select("id, display_name, email, status, must_change_pin")
      .eq("user_type", "staff")
      .order("display_name")
      .limit(500),
    db
      .from("user_roles")
      .select("user_id, effective_to, roles(name, description)")
      .lte("effective_from", nowIso)
      .limit(5000),
  ]);
  if (profiles.error || grants.error) return { ok: false };
  const rolesByUser = new Map<string, string[]>();
  for (const g of grants.data ?? []) {
    if (g.effective_to !== null && g.effective_to <= nowIso) continue;
    const list = rolesByUser.get(g.user_id) ?? [];
    list.push(g.roles?.description ?? g.roles?.name ?? "Unknown role");
    rolesByUser.set(g.user_id, list);
  }
  return {
    ok: true,
    staff: (profiles.data ?? []).map((p) => ({
      id: p.id,
      displayName: p.display_name,
      email: p.email,
      status: p.status,
      passwordChangePending: p.must_change_pin,
      activeRoles: rolesByUser.get(p.id) ?? [],
    })),
  };
}

export type GrantRow = {
  id: string;
  roleLabel: string;
  branchName: string | null; // null = company-wide
  effectiveFrom: string;
  effectiveTo: string | null;
  active: boolean;
  pending: boolean; // not started yet
};

export async function getStaffUser(db: Db, userId: string) {
  const { data: profile } = await db
    .from("profiles")
    .select("id, display_name, email, status, must_change_pin, user_type")
    .eq("id", userId)
    .maybeSingle();
  if (!profile || profile.user_type !== "staff") return null;
  const [{ data: grants }, { data: branches }] = await Promise.all([
    db
      .from("user_roles")
      .select(
        "id, branch_id, effective_from, effective_to, roles(name, description)",
      )
      .eq("user_id", userId)
      .order("effective_from", { ascending: false }),
    db.from("branches").select("id, name"),
  ]);
  const branchName = new Map((branches ?? []).map((b) => [b.id, b.name]));
  const now = new Date().toISOString();
  const rows: GrantRow[] = (grants ?? []).map((g) => ({
    id: g.id,
    roleLabel: g.roles?.description ?? g.roles?.name ?? "Unknown role",
    branchName: g.branch_id
      ? (branchName.get(g.branch_id) ?? "Unknown branch")
      : null,
    effectiveFrom: g.effective_from,
    effectiveTo: g.effective_to,
    active:
      g.effective_from <= now &&
      (g.effective_to === null || g.effective_to > now),
    pending:
      g.effective_from > now &&
      (g.effective_to === null || g.effective_to > g.effective_from),
  }));
  return {
    profile: {
      id: profile.id,
      displayName: profile.display_name,
      email: profile.email,
      status: profile.status,
      passwordChangePending: profile.must_change_pin,
    },
    grants: rows,
  };
}

export async function listAssignable(db: Db) {
  const [roles, branches] = await Promise.all([
    db.from("roles").select("id, name, description").order("description"),
    db.from("branches").select("id, name").eq("status", "active").order("name"),
  ]);
  if (roles.error || branches.error) return null;
  return {
    // staff roles only: the driver role is granted by driver creation, never by hand
    roles: (roles.data ?? []).filter((r) => r.name !== "driver"),
    branches: branches.data ?? [],
  };
}
