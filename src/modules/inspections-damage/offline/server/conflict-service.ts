import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import type { Outcome } from "@/modules/fleet-vehicles/domain/action-state";
import { inspectionDbMessage } from "../../domain/inspection-errors";
import {
  conflictStatusSchema,
  parseInput,
  reportSyncConflictSchema,
  resolveSyncConflictSchema,
} from "../domain/sync-schema";

// Sync conflicts (DEC-43; migration 050). Every call runs as the SIGNED-IN USER: the SQL functions authorise (the allocation's
// driver or the on-behalf completer reports; allocation.manage resolves, never your own report: DEC-24). The service-role key is
// never used here. A conflict stores the refusal only: no photos, no answers.
type Db = SupabaseClient<Database>;
const unavailable = {
  ok: false as const,
  message: "Something went wrong on our side. Please try again.",
};

export async function reportSyncConflict(
  db: Db,
  raw: unknown,
): Promise<Outcome<{ conflictId: string }>> {
  const p = parseInput(reportSyncConflictSchema, raw);
  if (!p.ok) return p;
  const { data, error } = await db.rpc("report_sync_conflict", {
    p_allocation_id: p.value.allocationId,
    p_inspection_id: p.value.inspectionId as string,
    p_function_name: p.value.functionName,
    p_refusal_code: p.value.refusalCode,
    p_refusal_message: p.value.refusalMessage,
    p_device_time: p.value.deviceTime as string,
    p_client_submission_id: p.value.clientSubmissionId,
  });
  if (error)
    return { ok: false, message: inspectionDbMessage(error), code: error.code };
  if (!data) return unavailable;
  return { ok: true, conflictId: data };
}

/** The phone asks whether a supervisor has resolved the conflicts it reported (its own rows only: RLS). */
export async function conflictStatus(
  db: Db,
  raw: unknown,
): Promise<
  Outcome<{
    conflicts: {
      clientSubmissionId: string;
      resolved: boolean;
      note: string | null;
      resolvedAt: string | null;
    }[];
  }>
> {
  const p = parseInput(conflictStatusSchema, raw);
  if (!p.ok) return p;
  const { data, error } = await db
    .from("inspection_sync_conflicts")
    .select("client_submission_id, resolved_at, resolution_note")
    .in("client_submission_id", p.value.clientSubmissionIds);
  if (error)
    return { ok: false, message: inspectionDbMessage(error), code: error.code };
  return {
    ok: true,
    conflicts: (data ?? []).map((r) => ({
      clientSubmissionId: r.client_submission_id,
      resolved: r.resolved_at !== null,
      note: r.resolution_note,
      resolvedAt: r.resolved_at,
    })),
  };
}

/** allocation.manage for the branch, a note (1-500), never your own report. */
export async function resolveSyncConflict(
  db: Db,
  raw: unknown,
): Promise<Outcome<{ conflictId: string }>> {
  const p = parseInput(resolveSyncConflictSchema, raw);
  if (!p.ok) return p;
  const { data, error } = await db.rpc("resolve_sync_conflict", {
    p_id: p.value.id,
    p_note: p.value.note,
    p_client_submission_id: p.value.clientSubmissionId,
  });
  if (error)
    return { ok: false, message: inspectionDbMessage(error), code: error.code };
  if (!data) return unavailable;
  return { ok: true, conflictId: data };
}

export type OverdueRow = {
  kind: "overdue" | "sync_conflict";
  allocationId: string;
  branchId: string;
  branchName: string;
  fleetNumber: string;
  registration: string;
  stage: string | null;
  plannedAt: string | null;
  dueBy: string | null;
  minutesOverdue: number | null;
  allocationStatus: string;
  capturedOffline: boolean | null;
  conflictId: string | null;
  functionName: string | null;
  refusalCode: string | null;
  refusalMessage: string | null;
  reportedAt: string | null;
};

/** The supervisor's Missing / Late list, live (no names: DEC-41). */
export async function listOverdue(
  db: Db,
  branchId?: string,
): Promise<Outcome<{ rows: OverdueRow[] }>> {
  const { data, error } = await db.rpc("list_overdue_inspections", {
    p_branch_id: branchId as string,
  });
  if (error)
    return { ok: false, message: inspectionDbMessage(error), code: error.code };
  return {
    ok: true,
    rows: (data ?? []).map((r) => ({
      kind: r.kind === "sync_conflict" ? "sync_conflict" : "overdue",
      allocationId: r.allocation_id,
      branchId: r.branch_id,
      branchName: r.branch_name,
      fleetNumber: r.vehicle_fleet_number,
      registration: r.vehicle_registration,
      stage: r.inspection_stage,
      plannedAt: r.planned_at,
      dueBy: r.due_by,
      minutesOverdue: r.minutes_overdue,
      allocationStatus: r.allocation_status,
      capturedOffline: r.captured_offline,
      conflictId: r.conflict_id,
      functionName: r.function_name,
      refusalCode: r.refusal_code,
      refusalMessage: r.refusal_message,
      reportedAt: r.reported_at,
    })),
  };
}
