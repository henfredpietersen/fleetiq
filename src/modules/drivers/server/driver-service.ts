import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { driverDbMessage } from "../domain/db-errors";
import {
  driverStatusSchema,
  issueMessages,
  licenceSchema,
  updateDriverSchema,
  verifyLicenceSchema,
} from "../domain/driver-schema";
import type { Outcome } from "../domain/outcome";

// Writes as the SIGNED-IN USER through the SECURITY DEFINER functions in migration 018. Each function
// authorises with has_permission() / can_view_licence() itself; zod here only gives early, friendly errors.
type Db = SupabaseClient<Database>;

const invalid = (error: Parameters<typeof issueMessages>[0]) => ({
  ok: false as const,
  message: "Check the details and try again.",
  details: issueMessages(error),
});

export async function updateDriver(
  db: Db,
  raw: unknown,
): Promise<Outcome<{ driverId: string }>> {
  const p = updateDriverSchema.safeParse(raw);
  if (!p.success) return invalid(p.error);
  const { error } = await db.rpc("update_driver_details", {
    p_driver_id: p.data.driverId,
    p_display_name: p.data.displayName,
    p_phone: p.data.phone,
  });
  if (error) return { ok: false, message: driverDbMessage(error) };
  return { ok: true, driverId: p.data.driverId };
}

export async function setDriverStatus(
  db: Db,
  raw: unknown,
): Promise<Outcome<{ driverId: string; status: "active" | "inactive" }>> {
  const p = driverStatusSchema.safeParse(raw);
  if (!p.success) return invalid(p.error);
  const { error } = await db.rpc("set_driver_status", {
    p_driver_id: p.data.driverId,
    p_status: p.data.status,
    p_reason: p.data.reason,
  });
  if (error) return { ok: false, message: driverDbMessage(error) };
  return { ok: true, driverId: p.data.driverId, status: p.data.status };
}

export async function recordLicence(
  db: Db,
  raw: unknown,
): Promise<Outcome<{ licenceId: string; driverId: string }>> {
  const p = licenceSchema.safeParse(raw);
  if (!p.success) return invalid(p.error);
  const v = p.data;
  const { data, error } = await db.rpc("record_driver_licence", {
    p_driver_id: v.driverId,
    p_licence_number: v.licenceNumber,
    p_licence_code: v.licenceCode,
    p_issue_date: v.issueDate,
    p_expiry_date: v.expiryDate,
    p_prdp_required: v.prdpRequired,
    // nullable in SQL; the generated type is non-null
    p_prdp_expiry_date: (v.prdpExpiryDate ?? null) as string,
    p_evidence_file_id: (v.evidenceFileId ?? null) as string,
    p_client_submission_id: v.clientSubmissionId,
  });
  if (error || !data)
    return { ok: false, message: driverDbMessage(error ?? {}) };
  return { ok: true, licenceId: data, driverId: v.driverId };
}

export async function verifyLicence(
  db: Db,
  raw: unknown,
): Promise<Outcome<{ driverId: string; decision: "verified" | "rejected" }>> {
  const p = verifyLicenceSchema.safeParse(raw);
  if (!p.success) return invalid(p.error);
  const { error } = await db.rpc("verify_driver_licence", {
    p_licence_id: p.data.licenceId,
    p_decision: p.data.decision,
    p_reason: p.data.reason,
  });
  if (error) return { ok: false, message: driverDbMessage(error) };
  return { ok: true, driverId: p.data.driverId, decision: p.data.decision };
}
