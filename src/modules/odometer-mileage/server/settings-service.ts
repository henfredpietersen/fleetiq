import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import type { Outcome } from "@/modules/fleet-vehicles/domain/action-state";
import { odometerDbMessage } from "../domain/odometer-errors";
import { parseInput, settingsSchema } from "../domain/review-schema";

// settings.validation.manage, company-wide (DEC-23). Runs as the signed-in user: RLS shows the rows to that grant only and
// set_validation_settings() re-checks it. A change closes the current version and starts the next one; nothing is edited or deleted.
type Db = SupabaseClient<Database>;
export type SettingsRow =
  Database["public"]["Tables"]["odometer_validation_settings"]["Row"];

export async function listSettings(
  db: Db,
): Promise<Outcome<{ rows: SettingsRow[] }>> {
  const { data, error } = await db
    .from("odometer_validation_settings")
    .select("*")
    .order("vehicle_category", { ascending: true, nullsFirst: true })
    .order("version", { ascending: false })
    .limit(500);
  if (error)
    return { ok: false, message: odometerDbMessage(error), code: error.code };
  return { ok: true, rows: data ?? [] };
}

export async function saveSettings(
  db: Db,
  raw: unknown,
): Promise<Outcome<{ id: string }>> {
  const p = parseInput(settingsSchema, raw);
  if (!p.ok) return p;
  const v = p.value;
  const { data, error } = await db.rpc("set_validation_settings", {
    p_vehicle_category: v.vehicleCategory as string,
    p_max_km_per_allocation: v.maxKmPerAllocation as number,
    p_ocr_min_confidence: v.ocrMinConfidence as number,
    p_ocr_driver_tolerance_km: v.ocrDriverToleranceKm,
    p_unaccounted_tolerance_km: v.unaccountedToleranceKm,
    p_pre_shift_late_minutes: v.preShiftLateMinutes,
    p_post_shift_late_minutes: v.postShiftLateMinutes,
    p_stale_reading_days: v.staleReadingDays,
    p_reason: v.reason,
    p_client_submission_id: v.clientSubmissionId,
  });
  if (error)
    return { ok: false, message: odometerDbMessage(error), code: error.code };
  if (!data)
    return {
      ok: false,
      message: "Something went wrong on our side. Please try again.",
    };
  return { ok: true, id: data };
}
