import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import type { Outcome } from "@/modules/fleet-vehicles/domain/action-state";
import { shiftDbMessage } from "../domain/db-errors";
import {
  adHocShiftSchema,
  archiveTemplateSchema,
  cancelShiftSchema,
  generateSchema,
  parseInput,
  templateSchema,
  updateTemplateSchema,
} from "../domain/shift-schema";

// Every call runs as the SIGNED-IN USER (anon key + session): the SQL functions and RLS authorise with
// has_permission('allocation.manage', branch). Input is validated with zod first. No service-role key on this path;
// the UI is never the boundary.
type Db = SupabaseClient<Database>;

const unavailable = {
  ok: false as const,
  message: "Something went wrong on our side. Please try again.",
};
/** Optional values travel as SQL NULL (the generated RPC types do not model nullable arguments). */
const nul = <T>(v: T | undefined): T => (v ?? null) as T;

export async function createTemplate(
  db: Db,
  raw: unknown,
): Promise<Outcome<{ id: string }>> {
  const p = parseInput(templateSchema, raw);
  if (!p.ok) return p;
  const { data, error } = await db.rpc("create_shift_template", {
    p_branch_id: p.value.branchId,
    p_name: p.value.name,
    p_start_time: p.value.startTime,
    p_end_time: p.value.endTime,
  });
  if (error) return { ok: false, message: shiftDbMessage(error) };
  if (!data) return unavailable;
  return { ok: true, id: data };
}

export async function updateTemplate(
  db: Db,
  raw: unknown,
): Promise<Outcome<object>> {
  const p = parseInput(updateTemplateSchema, raw);
  if (!p.ok) return p;
  const { error } = await db.rpc("update_shift_template", {
    p_template_id: p.value.templateId,
    p_name: p.value.name,
    p_start_time: p.value.startTime,
    p_end_time: p.value.endTime,
  });
  if (error) return { ok: false, message: shiftDbMessage(error) };
  return { ok: true };
}

export async function archiveTemplate(
  db: Db,
  raw: unknown,
): Promise<Outcome<object>> {
  const p = parseInput(archiveTemplateSchema, raw);
  if (!p.ok) return p;
  const { error } = await db.rpc("archive_shift_template", {
    p_template_id: p.value.templateId,
    p_reason: p.value.reason,
  });
  if (error) return { ok: false, message: shiftDbMessage(error) };
  return { ok: true };
}

/** Idempotent: retrying with the same client_submission_id returns the same counts and creates nothing new. */
export async function generateShifts(
  db: Db,
  raw: unknown,
): Promise<Outcome<{ created: number; skipped: number }>> {
  const p = parseInput(generateSchema, raw);
  if (!p.ok) return p;
  const { data, error } = await db.rpc("generate_shifts", {
    p_template_id: p.value.templateId,
    p_from: p.value.from,
    p_to: p.value.to,
    p_client_submission_id: p.value.clientSubmissionId,
  });
  if (error) return { ok: false, message: shiftDbMessage(error) };
  const row = data?.[0];
  if (!row) return unavailable;
  return { ok: true, created: row.created, skipped: row.skipped };
}

export async function createAdHocShift(
  db: Db,
  raw: unknown,
): Promise<Outcome<{ id: string }>> {
  const p = parseInput(adHocShiftSchema, raw);
  if (!p.ok) return p;
  const { data, error } = await db.rpc("create_shift", {
    p_branch_id: p.value.branchId,
    p_department_id: nul(p.value.departmentId),
    p_shift_date: p.value.shiftDate,
    p_start_time: p.value.startTime,
    p_end_time: p.value.endTime,
    p_client_submission_id: p.value.clientSubmissionId,
  });
  if (error) return { ok: false, message: shiftDbMessage(error) };
  if (!data) return unavailable;
  return { ok: true, id: data };
}

export async function cancelShift(
  db: Db,
  raw: unknown,
): Promise<Outcome<object>> {
  const p = parseInput(cancelShiftSchema, raw);
  if (!p.ok) return p;
  const { error } = await db.rpc("cancel_shift", {
    p_shift_id: p.value.shiftId,
    p_reason: p.value.reason,
  });
  if (error) return { ok: false, message: shiftDbMessage(error) };
  return { ok: true };
}
