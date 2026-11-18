import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import type { Outcome } from "@/modules/fleet-vehicles/domain/action-state";
import {
  amendCheckSchema,
  amendSchema,
  myAllocationsSchema,
  parseInput,
  transitionSchema,
} from "../domain/allocation-schema";
import { lifecycleDbMessage } from "../domain/lifecycle-errors";
import type { HistoryEvent, MyAllocation } from "../domain/lifecycle-types";

export type { HistoryEvent, MyAllocation };

// Every call runs as the SIGNED-IN USER: transition_allocation / amend_allocation_times / my_allocations authorise and
// re-check every rule themselves (the UI hides actions but is never the boundary). zod first; blanks become NULL.
type Db = SupabaseClient<Database>;
const nul = <T>(v: T | undefined): T => (v ?? null) as T;
const unavailable = {
  ok: false as const,
  message: "Something went wrong on our side. Please try again.",
};

/** start / cancel / no-show. Idempotent on clientSubmissionId: a retry returns success with replayed = true. */
export async function transitionAllocation(
  db: Db,
  raw: unknown,
): Promise<Outcome<{ status: string; replayed: boolean }>> {
  const p = parseInput(transitionSchema, raw);
  if (!p.ok) return p;
  const { data, error } = await db.rpc("transition_allocation", {
    p_allocation_id: p.value.allocationId,
    p_to_status: p.value.toStatus,
    p_reason: nul<string>(p.value.reason),
    p_client_submission_id: p.value.clientSubmissionId,
  });
  if (error) return { ok: false, message: lifecycleDbMessage(error) };
  const row = data?.[0];
  if (!row) return unavailable;
  return { ok: true, status: row.out_status, replayed: row.out_replayed };
}

export async function amendAllocationTimes(
  db: Db,
  raw: unknown,
): Promise<Outcome<{ replayed: boolean }>> {
  const p = parseInput(amendSchema, raw);
  if (!p.ok) return p;
  const { data, error } = await db.rpc("amend_allocation_times", {
    p_allocation_id: p.value.allocationId,
    p_planned_start_at: p.value.plannedStartAt,
    p_planned_end_at: p.value.plannedEndAt,
    p_reason: p.value.reason,
    p_client_submission_id: p.value.clientSubmissionId,
  });
  if (error) return { ok: false, message: lifecycleDbMessage(error) };
  const row = data?.[0];
  if (!row) return unavailable;
  return { ok: true, replayed: row.out_replayed };
}

const AMEND_TEXT: Record<string, string> = {
  status_not_amendable:
    "Only planned or pre-inspection-pending allocations can be changed.",
  shift_not_scheduled: "The shift is cancelled.",
  no_eligible_licence:
    "The driver's licence does not cover the new end date (it must be verified and valid until then).",
  vehicle_conflict: "The vehicle is already allocated during the new period.",
  driver_conflict: "The driver is already allocated during the new period.",
};

/** Dry run for the Amend dialog: the same rules as the amendment, read-only. */
export async function checkAmend(
  db: Db,
  raw: unknown,
): Promise<Outcome<{ eligible: boolean; problems: string[] }>> {
  const p = parseInput(amendCheckSchema, raw);
  if (!p.ok) return p;
  const { data, error } = await db.rpc("amend_eligibility", {
    p_allocation_id: p.value.allocationId,
    p_planned_start_at: p.value.plannedStartAt,
    p_planned_end_at: p.value.plannedEndAt,
  });
  if (error) return { ok: false, message: lifecycleDbMessage(error) };
  const row = data?.[0];
  if (!row) return unavailable;
  return {
    ok: true,
    eligible: row.ok,
    problems: (row.block_reasons ?? []).map(
      (r) => AMEND_TEXT[r] ?? "This period is not allowed.",
    ),
  };
}

/** The caller's own allocations in a range of at most 14 days (the function refuses more). */
export async function listMyAllocations(
  db: Db,
  raw: unknown,
): Promise<Outcome<{ allocations: MyAllocation[] }>> {
  const p = parseInput(myAllocationsSchema, raw);
  if (!p.ok) return p;
  const { data, error } = await db.rpc("my_allocations", {
    p_from: p.value.from,
    p_to: p.value.to,
  });
  if (error) return { ok: false, message: lifecycleDbMessage(error) };
  return {
    ok: true,
    allocations: (data ?? []).map((r) => ({
      id: r.allocation_id,
      status: r.status,
      plannedStartAt: r.planned_start_at,
      plannedEndAt: r.planned_end_at,
      shiftDate: r.shift_date,
      shiftStartAt: r.shift_start_at,
      shiftEndAt: r.shift_end_at,
      fleetNumber: r.vehicle_fleet_number,
      registration: r.vehicle_registration,
      make: r.vehicle_make,
      model: r.vehicle_model,
      branchName: r.branch_name,
      licenceClassCheck: r.licence_class_check,
      canOpen: r.can_open,
      openedOnBehalf: r.opened_on_behalf,
    })),
  };
}

/** Status history for the drawer: allocation_events, visible exactly when the allocation is (RLS). */
export async function getAllocationHistory(
  db: Db,
  allocationId: string,
): Promise<Outcome<{ events: HistoryEvent[] }>> {
  const id = parseInput(transitionSchema.shape.allocationId, allocationId);
  if (!id.ok) return id;
  const { data, error } = await db
    .from("allocation_events")
    .select(
      "id, event_type, occurred_at, actor_id, reason, previous_value, new_value, metadata",
    )
    .eq("allocation_id", id.value)
    .order("occurred_at")
    .order("id")
    .limit(200);
  if (error) return { ok: false, message: lifecycleDbMessage(error) };
  const rows = data ?? [];
  const actors = [...new Set(rows.map((r) => r.actor_id))];
  const names = actors.length
    ? await db.from("profiles").select("id, display_name").in("id", actors)
    : { data: [] };
  const name = new Map((names.data ?? []).map((n) => [n.id, n.display_name]));
  const obj = (v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  return {
    ok: true,
    events: rows.map((r) => ({
      id: r.id,
      eventType: r.event_type,
      occurredAt: r.occurred_at,
      actorName: name.get(r.actor_id) ?? "A user",
      reason: r.reason,
      previous: obj(r.previous_value),
      next: obj(r.new_value),
      onBehalf: obj(r.metadata)?.on_behalf === true,
    })),
  };
}
