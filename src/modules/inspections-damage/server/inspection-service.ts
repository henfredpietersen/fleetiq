import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import type { Outcome } from "@/modules/fleet-vehicles/domain/action-state";
import { inspectionDbMessage } from "../domain/inspection-errors";
import {
  beginSchema,
  listInspectionsSchema,
  myInspectionSchema,
  parseInput,
  saveSchema,
  submitSchema,
} from "../domain/inspection-schema";
import {
  myInspectionDoc,
  type InspectionListRow,
  type MyInspection,
} from "../domain/inspection-types";

// Every call runs as the SIGNED-IN USER: the SQL functions authorise and re-check every rule themselves (the UI hides
// actions but is never the boundary). zod first; blanks become NULL. Idempotent: the caller sends the same
// clientSubmissionId on every retry (DEC-06). The service-role key is never used here.
type Db = SupabaseClient<Database>;
const nul = <T>(v: T | undefined): T => (v ?? null) as T;
const unavailable = {
  ok: false as const,
  message: "Something went wrong on our side. Please try again.",
};

export async function beginInspection(
  db: Db,
  raw: unknown,
): Promise<Outcome<{ inspectionId: string }>> {
  const p = parseInput(beginSchema, raw);
  if (!p.ok) return p;
  const { data, error } = await db.rpc("begin_inspection", {
    p_allocation_id: p.value.allocationId,
    p_stage: p.value.stage,
    p_device_started_at: nul<string>(p.value.deviceStartedAt),
    p_captured_offline: p.value.capturedOffline,
    p_client_submission_id: p.value.clientSubmissionId,
  });
  if (error) return { ok: false, message: inspectionDbMessage(error) };
  if (!data) return unavailable;
  return { ok: true, inspectionId: data };
}

export async function saveResponses(
  db: Db,
  raw: unknown,
): Promise<Outcome<{ inspectionId: string }>> {
  const p = parseInput(saveSchema, raw);
  if (!p.ok) return p;
  const { data, error } = await db.rpc("save_inspection_responses", {
    p_inspection_id: p.value.inspectionId,
    p_responses: p.value.responses.map((r) => ({
      template_item_id: r.templateItemId,
      value: r.value,
      comment: nul<string>(r.comment),
      device_answered_at: nul<string>(r.deviceAnsweredAt),
    })),
    p_vehicle_confirmed: nul<boolean>(p.value.vehicleConfirmed),
    p_client_submission_id: p.value.clientSubmissionId,
  });
  if (error) return { ok: false, message: inspectionDbMessage(error) };
  if (!data) return unavailable;
  return { ok: true, inspectionId: data };
}

export async function submitInspection(
  db: Db,
  raw: unknown,
): Promise<
  Outcome<{
    status: string;
    lateFlag: boolean;
    safetyDefectFlag: boolean;
    replayed: boolean;
  }>
> {
  const p = parseInput(submitSchema, raw);
  if (!p.ok) return p;
  const { data, error } = await db.rpc("submit_inspection", {
    p_inspection_id: p.value.inspectionId,
    p_device_submitted_at: nul<string>(p.value.deviceSubmittedAt),
    p_captured_offline: p.value.capturedOffline,
    p_client_submission_id: p.value.clientSubmissionId,
  });
  if (error) return { ok: false, message: inspectionDbMessage(error) };
  const row = data?.[0];
  if (!row) return unavailable;
  return {
    ok: true,
    status: row.out_status,
    lateFlag: row.out_late_flag,
    safetyDefectFlag: row.out_safety_defect_flag,
    replayed: row.out_replayed,
  };
}

/** The driver's form: items for the stage, current answers, photo slots, whether the odometer photo is present. */
export async function getMyInspection(
  db: Db,
  raw: unknown,
): Promise<Outcome<{ inspection: MyInspection }>> {
  const p = parseInput(myInspectionSchema, raw);
  if (!p.ok) return p;
  const { data, error } = await db.rpc("my_inspection", {
    p_allocation_id: p.value.allocationId,
    p_stage: p.value.stage,
  });
  if (error) return { ok: false, message: inspectionDbMessage(error) };
  const doc = myInspectionDoc.safeParse(data);
  if (!doc.success) return unavailable;
  return { ok: true, inspection: doc.data };
}

/** The supervisor's list (allocation.manage or reports.view for the branch, checked in the function). */
export async function listInspections(
  db: Db,
  raw: unknown,
): Promise<Outcome<{ rows: InspectionListRow[] }>> {
  const p = parseInput(listInspectionsSchema, raw);
  if (!p.ok) return p;
  const { data, error } = await db.rpc("list_inspections", {
    p_from: p.value.from,
    p_to: p.value.to,
    p_branch_id: nul<string>(p.value.branchId),
    p_limit: nul<number>(p.value.limit),
  });
  if (error) return { ok: false, message: inspectionDbMessage(error) };
  return {
    ok: true,
    rows: (data ?? []).map((r) => ({
      id: r.inspection_id,
      allocationId: r.allocation_id,
      branchId: r.branch_id,
      branchName: r.branch_name,
      shiftDate: r.shift_date,
      stage: r.inspection_stage,
      status: r.status,
      fleetNumber: r.vehicle_fleet_number,
      registration: r.vehicle_registration,
      startedAt: r.started_at,
      submittedAt: r.submitted_at,
      lateFlag: r.late_flag,
      safetyDefectFlag: r.safety_defect_flag,
      capturedOffline: r.captured_offline,
      completedByRole: r.completed_by_role,
      allocationStatus: r.allocation_status,
    })),
  };
}
