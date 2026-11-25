import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import type { Outcome } from "@/modules/fleet-vehicles/domain/action-state";
import { odometerDbMessage } from "../domain/odometer-errors";
import {
  parseInput,
  quickCheckSchema,
  reviewSchema,
  sendToFullSchema,
} from "../domain/review-schema";
import {
  checksDoc,
  detailDoc,
  quickCheckReply,
  type ItemResult,
  type ReadingDetail,
  type ReviewRow,
} from "../domain/review-types";

// Every call runs as the SIGNED-IN USER: the SQL functions authorise (permission per branch, DEC-24 / DEC-44, the stale-version rule) and
// re-check everything; the UI hides what the person may not do but is never the boundary. The service-role key is never used here.
// Idempotent: the caller sends the same clientSubmissionId on every retry.
type Db = SupabaseClient<Database>;
const unavailable = {
  ok: false as const,
  message: "Something went wrong on our side. Please try again.",
};

export type ReviewBranch = { id: string; name: string; canApprove: boolean };

/** The branches the caller may check readings for (odometer.exception.review), and where they may also decide a full review. */
export async function reviewBranches(
  db: Db,
): Promise<Outcome<{ branches: ReviewBranch[] }>> {
  const { data, error } = await db
    .from("branches")
    .select("id, name")
    .order("name")
    .limit(200);
  if (error)
    return { ok: false, message: odometerDbMessage(error), code: error.code };
  const out: ReviewBranch[] = [];
  for (const b of data ?? []) {
    const [rev, app] = await Promise.all([
      db.rpc("has_permission", {
        permission_key: "odometer.exception.review",
        target_branch_id: b.id,
      }),
      db.rpc("has_permission", {
        permission_key: "odometer.exception.approve",
        target_branch_id: b.id,
      }),
    ]);
    if (rev.data === true)
      out.push({ id: b.id, name: b.name, canApprove: app.data === true });
  }
  return { ok: true, branches: out };
}

export async function listReview(
  db: Db,
  queue: "quick_check" | "full",
  branchId?: string,
): Promise<Outcome<{ rows: ReviewRow[] }>> {
  const { data, error } = await db.rpc("list_odometer_review", {
    p_queue: queue,
    p_branch_id: branchId,
    p_limit: queue === "quick_check" ? 50 : 200,
  });
  if (error)
    return { ok: false, message: odometerDbMessage(error), code: error.code };
  const rows: ReviewRow[] = (data ?? []).map((r) => {
    const checks = checksDoc.safeParse(r.checks);
    return {
      readingId: r.reading_id,
      validatedAt: r.validated_at,
      branchId: r.branch_id,
      branchName: r.branch_name,
      vehicleId: r.vehicle_id,
      fleetNumber: r.fleet_number,
      registration: r.registration,
      inspectionId: r.inspection_id,
      allocationId: r.allocation_id,
      stage: r.inspection_stage as ReviewRow["stage"],
      plannedStartAt: r.planned_start_at,
      plannedEndAt: r.planned_end_at,
      driverReadingKm: r.driver_reading_km,
      driverName: r.driver_name,
      evidenceFileId: r.evidence_file_id,
      capturedOffline: r.captured_offline,
      lateFlag: r.late_flag,
      submittedAt: r.submitted_at,
      reviewKind: r.review_kind as ReviewRow["reviewKind"],
      checks: checks.success ? checks.data : [],
      failedChecks: r.failed_checks ?? [],
      fullReviewNote: r.full_review_note,
      previousAcceptedKm: r.previous_accepted_km,
      previousAcceptedAt: r.previous_accepted_at,
      blockedReason: r.blocked_reason,
      canDecide: r.can_decide,
    };
  });
  return { ok: true, rows };
}

export async function reviewCounts(
  db: Db,
  branchId?: string,
): Promise<Outcome<{ quickCheck: number; fullReview: number }>> {
  const { data, error } = await db.rpc("odometer_review_counts", {
    p_branch_id: branchId,
  });
  if (error)
    return { ok: false, message: odometerDbMessage(error), code: error.code };
  const r = data?.[0];
  return {
    ok: true,
    quickCheck: r?.quick_check ?? 0,
    fullReview: r?.full_review ?? 0,
  };
}

export async function readingDetail(
  db: Db,
  readingId: string,
): Promise<Outcome<{ row: ReviewRow | null; detail: ReadingDetail }>> {
  const { data, error } = await db.rpc("odometer_review_detail", {
    p_reading_id: readingId,
  });
  if (error)
    return { ok: false, message: odometerDbMessage(error), code: error.code };
  const d = detailDoc.safeParse(data);
  if (!d.success) return unavailable;
  // the same row shape as the list: read it from the list function so the two never disagree
  const kind = (data as { reading?: { review_kind?: string } } | null)?.reading
    ?.review_kind;
  let row: ReviewRow | null = null;
  if (kind === "quick_check" || kind === "full") {
    const l = await listReview(db, kind);
    if (l.ok) row = l.rows.find((r) => r.readingId === readingId) ?? null;
  }
  return { ok: true, row, detail: d.data };
}

export async function quickCheckAccept(
  db: Db,
  raw: unknown,
): Promise<
  Outcome<{ results: ItemResult[]; accepted: number; refused: number }>
> {
  const p = parseInput(quickCheckSchema, raw);
  if (!p.ok) return p;
  const { data, error } = await db.rpc("quick_check_accept", {
    p_items: p.value.items.map((i) => ({
      reading_id: i.readingId,
      validated_at: i.validatedAt,
    })),
    p_client_submission_id: p.value.clientSubmissionId,
  });
  if (error)
    return { ok: false, message: odometerDbMessage(error), code: error.code };
  const r = quickCheckReply.safeParse(data);
  if (!r.success) return unavailable;
  return {
    ok: true,
    accepted: r.data.accepted,
    refused: r.data.refused,
    results: r.data.results.map((x) => ({
      readingId: x.reading_id,
      result: x.result,
      code: x.code,
      message: x.message,
    })),
  };
}

export async function sendToFullReview(
  db: Db,
  raw: unknown,
): Promise<Outcome<{ readingId: string }>> {
  const p = parseInput(sendToFullSchema, raw);
  if (!p.ok) return p;
  const { error } = await db.rpc("send_to_full_review", {
    p_reading_id: p.value.readingId,
    p_note: p.value.note,
    p_client_submission_id: p.value.clientSubmissionId,
  });
  if (error)
    return { ok: false, message: odometerDbMessage(error), code: error.code };
  return { ok: true, readingId: p.value.readingId };
}

export async function reviewReading(
  db: Db,
  raw: unknown,
): Promise<Outcome<{ readingId: string }>> {
  const p = parseInput(reviewSchema, raw);
  if (!p.ok) return p;
  const { error } = await db.rpc("review_reading", {
    p_reading_id: p.value.readingId,
    p_decision: p.value.decision,
    p_accepted_km:
      p.value.decision === "accept_value" ? (p.value.acceptedKm ?? null) : null,
    p_reason: p.value.reason,
    p_client_submission_id: p.value.clientSubmissionId,
  });
  if (error)
    return { ok: false, message: odometerDbMessage(error), code: error.code };
  return { ok: true, readingId: p.value.readingId };
}
