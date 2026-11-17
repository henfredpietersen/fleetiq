import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import type { DriverFilters } from "../domain/driver-schema";
import type { LicenceSummary } from "../domain/licence-expiry";

// Read paths, run as the signed-in user. The register comes from the driver_register view (names, no licence
// numbers); licence numbers and evidence come only from driver_licences, whose RLS requires
// driver.licence.view_sensitive (Own / Branch / All, DEC-23). Everyone else gets the safe view.
type Db = SupabaseClient<Database>;

export type BranchOption = { id: string; name: string };

export async function listBranches(db: Db) {
  const { data, error } = await db
    .from("branches")
    .select("id, name")
    .eq("status", "active")
    .order("name");
  if (error) return { ok: false as const };
  return { ok: true as const, branches: (data ?? []) as BranchOption[] };
}

/** Branches where the user holds driver.manage — the same has_permission() RLS and the SQL functions use. */
export async function manageableBranchIds(
  db: Db,
  branches: BranchOption[],
): Promise<Set<string>> {
  const checks = await Promise.all(
    branches.map(async (b) => {
      const { data } = await db.rpc("has_permission", {
        permission_key: "driver.manage",
        target_branch_id: b.id,
      });
      return data === true ? b.id : null;
    }),
  );
  return new Set(checks.filter((id): id is string => id !== null));
}

export type DriverRow = {
  id: string;
  branchId: string;
  employeeNumber: string;
  displayName: string;
  activeStatus: "active" | "inactive";
  /** Only for users who manage drivers in that branch (the view blanks it for everyone else). */
  phone: string | null;
  pinChangePending: boolean;
  licence: LicenceSummary;
};

type RegisterViewRow = Omit<
  Database["public"]["Views"]["driver_register"]["Row"],
  "company_id"
>;

function toDriverRow(r: RegisterViewRow): DriverRow {
  return {
    id: r.id ?? "",
    branchId: r.branch_id ?? "",
    employeeNumber: r.employee_number ?? "",
    displayName: r.display_name ?? "",
    activeStatus: r.active_status === "inactive" ? "inactive" : "active",
    phone: r.phone,
    pinChangePending: r.pin_change_pending === true,
    licence: {
      licenceExpiry: r.licence_expiry_date,
      prdpExpiry: r.prdp_expiry_date,
      verification: r.licence_verification_status,
    },
  };
}

const REGISTER_COLUMNS =
  "id, branch_id, employee_number, display_name, active_status, phone, pin_change_pending, licence_expiry_date, prdp_expiry_date, licence_verification_status";

export async function listDrivers(
  db: Db,
  f: DriverFilters,
): Promise<{ ok: true; drivers: DriverRow[] } | { ok: false }> {
  let q = db
    .from("driver_register")
    .select(REGISTER_COLUMNS)
    .order("employee_number")
    .limit(500);
  if (f.branchId) q = q.eq("branch_id", f.branchId);
  if (f.status) q = q.eq("active_status", f.status);
  if (f.q) {
    // letters, digits, space and hyphen only: nothing here can alter the filter expression
    const t = `%${f.q.replace(/[^\p{L}\p{N} -]/gu, "")}%`;
    q = q.or(`employee_number.ilike.${t},display_name.ilike.${t}`);
  }
  const { data, error } = await q;
  if (error) return { ok: false };
  return { ok: true, drivers: (data ?? []).map(toDriverRow) };
}

export async function getDriver(db: Db, id: string) {
  const { data, error } = await db
    .from("driver_register")
    .select(REGISTER_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (error) return { ok: false as const };
  if (!data) return { ok: true as const, driver: null };
  // profile_id is needed only to reset the PIN; the drivers table is readable to the same people
  const { data: base } = await db
    .from("drivers")
    .select("profile_id")
    .eq("id", id)
    .maybeSingle();
  return {
    ok: true as const,
    driver: { ...toDriverRow(data), profileId: base?.profile_id ?? null },
  };
}

export type LicenceRow = {
  id: string;
  licenceCode: string;
  issueDate: string;
  expiryDate: string;
  prdpRequired: boolean;
  prdpExpiryDate: string | null;
  verificationStatus: string;
  hasEvidence: boolean;
  createdAt: string;
  /** null unless the caller holds driver.licence.view_sensitive in scope (the base table hides the row). */
  licenceNumber: string | null;
  evidenceFileId: string | null;
  createdBy: string | null;
};

export async function listLicences(
  db: Db,
  driverId: string,
): Promise<{ ok: true; licences: LicenceRow[] } | { ok: false }> {
  const [safe, sensitive] = await Promise.all([
    db
      .from("driver_licences_safe")
      .select(
        "id, licence_code, issue_date, expiry_date, prdp_required, prdp_expiry_date, verification_status, has_evidence, created_at",
      )
      .eq("driver_id", driverId)
      .order("expiry_date", { ascending: false }),
    db
      .from("driver_licences")
      .select("id, licence_number, evidence_file_id, created_by")
      .eq("driver_id", driverId),
  ]);
  if (safe.error) return { ok: false };
  // a refused/empty sensitive read is normal for supervisors-without-permission: they just see the safe columns
  const extra = new Map((sensitive.data ?? []).map((s) => [s.id, s]));
  return {
    ok: true,
    licences: (safe.data ?? []).map((l) => {
      const s = extra.get(l.id ?? "");
      return {
        id: l.id ?? "",
        licenceCode: l.licence_code ?? "",
        issueDate: l.issue_date ?? "",
        expiryDate: l.expiry_date ?? "",
        prdpRequired: l.prdp_required === true,
        prdpExpiryDate: l.prdp_expiry_date,
        verificationStatus: l.verification_status ?? "recorded",
        hasEvidence: l.has_evidence === true,
        createdAt: l.created_at ?? "",
        licenceNumber: s?.licence_number ?? null,
        evidenceFileId: s?.evidence_file_id ?? null,
        createdBy: s?.created_by ?? null,
      };
    }),
  };
}
