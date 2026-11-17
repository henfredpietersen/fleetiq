import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import type { Outcome } from "../domain/action-state";
import { vehicleDbMessage } from "../domain/db-errors";
import {
  archiveSchema,
  cancelSchema,
  createVehicleSchema,
  decisionSchema,
  parseInput,
  transferRequestSchema,
  updateVehicleSchema,
} from "../domain/vehicle-schema";

// Every call here runs as the SIGNED-IN USER (anon key + session): RLS and the SQL functions decide.
// No service-role key on this path. The UI is never the boundary.
type Db = SupabaseClient<Database>;

const unavailable = {
  ok: false as const,
  message: "Something went wrong on our side. Please try again.",
};
const denied = (): Outcome<never> => ({
  ok: false,
  message: "That vehicle was not found, or you are not allowed to change it.",
});

export async function createVehicle(
  db: Db,
  raw: unknown,
): Promise<Outcome<{ id: string }>> {
  const p = parseInput(createVehicleSchema, raw);
  if (!p.ok) return p;
  const v = p.value;
  // vehicle + first branch assignment in one transaction, vehicle.manage checked in SQL (DB §4)
  const { data, error } = await db.rpc("create_vehicle", {
    p_branch_id: v.branchId,
    p_fleet_number: v.fleetNumber,
    p_registration_number: v.registrationNumber,
    p_make: v.make,
    p_model: v.model,
    p_vehicle_category: v.vehicleCategory,
    p_variant: v.variant,
    p_model_year: v.modelYear,
    p_vin: v.vin,
    p_engine_number: v.engineNumber,
    p_fuel_type: v.fuelType,
    p_transmission: v.transmission,
    p_administrative_status: v.administrativeStatus,
  });
  if (error) return { ok: false, message: vehicleDbMessage(error) };
  if (!data) return unavailable;
  return { ok: true, id: data.id };
}

export async function updateVehicle(
  db: Db,
  raw: unknown,
): Promise<Outcome<{ id: string }>> {
  const p = parseInput(updateVehicleSchema, raw);
  if (!p.ok) return p;
  const v = p.value;
  // Column-level grants mean only these fields can be written; caches are not among them.
  const { data, error } = await db
    .from("vehicles")
    .update({
      fleet_number: v.fleetNumber,
      registration_number: v.registrationNumber,
      make: v.make,
      model: v.model,
      vehicle_category: v.vehicleCategory,
      variant: v.variant ?? null,
      model_year: v.modelYear ?? null,
      vin: v.vin ?? null,
      engine_number: v.engineNumber ?? null,
      fuel_type: v.fuelType ?? null,
      transmission: v.transmission ?? null,
      administrative_status: v.administrativeStatus,
    })
    .eq("id", v.id)
    .select("id");
  if (error) return { ok: false, message: vehicleDbMessage(error) };
  if (!data || data.length === 0) return denied(); // RLS hid it or no vehicle.manage
  return { ok: true, id: v.id };
}

/** Archive / restore. Vehicles are never deleted (DB §4, CLAUDE.md). */
export async function setVehicleArchived(
  db: Db,
  raw: unknown,
): Promise<Outcome<{ id: string; archived: boolean }>> {
  const p = parseInput(archiveSchema, raw);
  if (!p.ok) return p;
  const { id, archived } = p.value;
  const { data, error } = await db
    .from("vehicles")
    .update({ archived_at: archived ? new Date().toISOString() : null })
    .eq("id", id)
    .select("id");
  if (error) return { ok: false, message: vehicleDbMessage(error) };
  if (!data || data.length === 0) return denied();
  return { ok: true, id, archived };
}

/** Requests a transfer. Nothing moves until a different fleet administrator approves (DEC-31, DEC-24). */
export async function requestTransfer(
  db: Db,
  raw: unknown,
): Promise<Outcome<{ approvalId: string }>> {
  const p = parseInput(transferRequestSchema, raw);
  if (!p.ok) return p;
  const v = p.value;
  const { data, error } = await db.rpc("request_vehicle_transfer", {
    p_vehicle_id: v.vehicleId,
    p_to_branch_id: v.toBranchId,
    p_reason: v.reason,
    p_client_submission_id: v.clientSubmissionId,
  });
  if (error) return { ok: false, message: vehicleDbMessage(error) };
  if (!data) return unavailable;
  return { ok: true, approvalId: data.id };
}

export async function decideTransfer(
  db: Db,
  raw: unknown,
): Promise<Outcome<{ decision: "approved" | "rejected" }>> {
  const p = parseInput(decisionSchema, raw);
  if (!p.ok) return p;
  const v = p.value;
  // permission, segregation of duties and the transfer itself are all in SQL, one transaction
  const { data, error } = await db.rpc("decide_approval", {
    p_approval_id: v.approvalId,
    p_decision: v.decision,
    p_notes: v.notes,
  });
  if (error) return { ok: false, message: vehicleDbMessage(error) };
  if (!data) return unavailable;
  return { ok: true, decision: v.decision };
}

export async function cancelTransfer(db: Db, raw: unknown): Promise<Outcome> {
  const p = parseInput(cancelSchema, raw);
  if (!p.ok) return p;
  const { error } = await db.rpc("cancel_approval", {
    p_approval_id: p.value.approvalId,
  });
  if (error) return { ok: false, message: vehicleDbMessage(error) };
  return { ok: true };
}
