import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import type { Outcome } from "@/modules/fleet-vehicles/domain/action-state";
import { allocationDbMessage } from "../domain/allocation-errors";
import {
  decideOverrideSchema,
  eligibilitySchema,
  parseInput,
  requestAllocationSchema,
  requiredLicenceCodeSchema,
} from "../domain/allocation-schema";
import type { EligibilityResult } from "../domain/allocation-text";

// Every call runs as the SIGNED-IN USER (anon key + session): the SQL functions and RLS authorise with
// has_permission('allocation.manage' | 'vehicle.manage', ...) and re-check every rule themselves. zod first.
// No service-role key on this path; the UI is never the boundary.
type Db = SupabaseClient<Database>;

const unavailable = {
  ok: false as const,
  message: "Something went wrong on our side. Please try again.",
};
const nul = <T>(v: T | undefined): T => (v ?? null) as T;

/** Explains a refusal before submitting. The database function is the authority and is re-run on submit. */
export async function checkEligibility(
  db: Db,
  raw: unknown,
): Promise<Outcome<{ result: EligibilityResult }>> {
  const p = parseInput(eligibilitySchema, raw);
  if (!p.ok) return p;
  const { data, error } = await db.rpc("allocation_eligibility", {
    p_vehicle_id: p.value.vehicleId,
    p_driver_id: p.value.driverId,
    p_shift_id: p.value.shiftId,
    p_planned_start_at: nul<string>(undefined),
    p_planned_end_at: nul<string>(undefined),
  });
  if (error) return { ok: false, message: allocationDbMessage(error) };
  const row = data?.[0];
  if (!row) return unavailable;
  return {
    ok: true,
    result: {
      ok: row.ok,
      blockReasons: row.block_reasons ?? [],
      licenceClassCheck: row.licence_class_check,
      needsOverride: row.needs_override,
    },
  };
}

/**
 * Creates the allocation, or — on a licence class mismatch — an approval request. Idempotent on the submission id for
 * both outcomes: a retry returns the same ids.
 */
export async function requestAllocation(
  db: Db,
  raw: unknown,
): Promise<
  Outcome<{ allocationId: string | null; approvalId: string | null }>
> {
  const p = parseInput(requestAllocationSchema, raw);
  if (!p.ok) return p;
  const { data, error } = await db.rpc("request_allocation", {
    p_shift_id: p.value.shiftId,
    p_vehicle_id: p.value.vehicleId,
    p_driver_id: p.value.driverId,
    p_planned_start_at: nul<string>(undefined),
    p_planned_end_at: nul<string>(undefined),
    p_reason: nul(p.value.reason),
    p_client_submission_id: p.value.clientSubmissionId,
  });
  if (error) return { ok: false, message: allocationDbMessage(error) };
  const row = data?.[0];
  if (!row) return unavailable;
  return {
    ok: true,
    allocationId: row.allocation_id,
    approvalId: row.approval_id,
  };
}

/** Approve or reject a licence override. The database refuses the requester and the driver (DEC-24). */
export async function decideLicenceOverride(
  db: Db,
  raw: unknown,
): Promise<Outcome<object>> {
  const p = parseInput(decideOverrideSchema, raw);
  if (!p.ok) return p;
  const { error } = await db.rpc("decide_approval", {
    p_approval_id: p.value.approvalId,
    p_decision: p.value.decision,
    p_notes: nul(p.value.notes),
  });
  if (error) return { ok: false, message: allocationDbMessage(error) };
  return { ok: true };
}

/** vehicle.manage (company-wide), with a reason; an empty code clears it ("not configured"). */
export async function setRequiredLicenceCode(
  db: Db,
  raw: unknown,
): Promise<Outcome<object>> {
  const p = parseInput(requiredLicenceCodeSchema, raw);
  if (!p.ok) return p;
  const { error } = await db.rpc("set_vehicle_required_licence_code", {
    p_vehicle_id: p.value.vehicleId,
    p_code: nul(p.value.code),
    p_reason: p.value.reason,
  });
  if (error) return { ok: false, message: allocationDbMessage(error) };
  return { ok: true };
}
