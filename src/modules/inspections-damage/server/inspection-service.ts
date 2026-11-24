import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import type { Outcome } from "@/modules/fleet-vehicles/domain/action-state";
import { inspectionDbMessage } from "../domain/inspection-errors";
import {
  attachDefectSchema,
  attachOdometerSchema,
  beginSchema,
  listInspectionsSchema,
  myInspectionSchema,
  parseInput,
  saveSchema,
  submitSchema,
} from "../domain/inspection-schema";
import {
  beginOnBehalfSchema,
  confirmKnownDamageSchema,
} from "../domain/damage-schema";
import {
  myInspectionDoc,
  newDamageDoc,
  type InspectionListRow,
  type InspectionNewDamage,
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

/** DEC-42: "I have checked the known damage list" (idempotent). */
export async function confirmKnownDamage(
  db: Db,
  raw: unknown,
): Promise<Outcome<{ inspectionId: string }>> {
  const p = parseInput(confirmKnownDamageSchema, raw);
  if (!p.ok) return p;
  const { data, error } = await db.rpc("confirm_known_damage_reviewed", {
    p_inspection_id: p.value.inspectionId,
    p_client_submission_id: p.value.clientSubmissionId,
  });
  if (error) return { ok: false, message: inspectionDbMessage(error) };
  if (!data) return unavailable;
  return { ok: true, inspectionId: data };
}

/**
 * DEC-09: a supervisor (allocation.manage + inspection.submit, not the driver) begins the POST-shift inspection on the driver's
 * behalf, with a reason. The database re-checks every rule, including "void the driver's draft first".
 */
export async function beginInspectionOnBehalf(
  db: Db,
  raw: unknown,
): Promise<Outcome<{ inspectionId: string }>> {
  const p = parseInput(beginOnBehalfSchema, raw);
  if (!p.ok) return p;
  const { data, error } = await db.rpc("begin_inspection_on_behalf", {
    p_allocation_id: p.value.allocationId,
    p_reason: p.value.reason,
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

export async function attachOdometerPhoto(
  db: Db,
  raw: unknown,
): Promise<Outcome<{ photoId: string }>> {
  const p = parseInput(attachOdometerSchema, raw);
  if (!p.ok) return p;
  const { data, error } = await db.rpc("attach_odometer_photo", {
    p_inspection_id: p.value.inspectionId,
    p_evidence_file_id: p.value.evidenceFileId,
    p_client_submission_id: p.value.clientSubmissionId,
  });
  if (error) return { ok: false, message: inspectionDbMessage(error) };
  if (!data) return unavailable;
  return { ok: true, photoId: data };
}

/** A condition/defect photo, linked to the checklist item it shows (the database requires one per Defect, IN004). */
export async function attachDefectPhoto(
  db: Db,
  raw: unknown,
): Promise<Outcome<{ photoId: string }>> {
  const p = parseInput(attachDefectSchema, raw);
  if (!p.ok) return p;
  const { data, error } = await db.rpc("attach_inspection_photo", {
    p_inspection_id: p.value.inspectionId,
    p_evidence_file_id: p.value.evidenceFileId,
    p_category: "damage",
    p_template_item_id: p.value.templateItemId,
    p_client_submission_id: p.value.clientSubmissionId,
  });
  if (error) return { ok: false, message: inspectionDbMessage(error) };
  if (!data) return unavailable;
  return { ok: true, photoId: data };
}

/** The branch an inspection belongs to (the caller's own RLS decides whether they can see it at all). */
export async function inspectionBranch(
  db: Db,
  inspectionId: string,
): Promise<Outcome<{ branchId: string }>> {
  const { data, error } = await db
    .from("inspections")
    .select("branch_id")
    .eq("id", inspectionId)
    .maybeSingle();
  if (error) return { ok: false, message: inspectionDbMessage(error) };
  if (!data) {
    return {
      ok: false,
      message: "That inspection was not found, or you cannot access it.",
    };
  }
  return { ok: true, branchId: data.branch_id };
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
      deviceFlag: r.device_flag ?? null,
      newDamageFlag: r.new_damage_flag,
      knownDamageReviewed: r.known_damage_reviewed,
    })),
  };
}

export type InspectionPhotoRef = {
  evidenceFileId: string;
  /** Odometer photos only: false = an earlier photo that was replaced by a retake (kept, never deleted). */
  isCurrent?: boolean;
  takenAt: string;
  templateItemId?: string | null;
  category?: string;
};
export type InspectionDetail = {
  id: string;
  stage: string;
  status: string;
  branchId: string;
  fleetNumber: string;
  registration: string;
  make: string;
  model: string;
  vehicleConfirmed: boolean;
  lateFlag: boolean;
  safetyDefectFlag: boolean;
  capturedOffline: boolean;
  deviceFlag: string | null;
  completedByRole: string;
  /** DEC-09: why the supervisor completed it (null for a driver's own inspection). */
  onBehalfReason: string | null;
  newDamageFlag: boolean;
  knownDamageReviewed: boolean;
  /** Damage reported in this inspection, with the interval for pre-shift reports. */
  newDamage: InspectionNewDamage[];
  /** Server times. */
  startedAt: string;
  submittedAt: string | null;
  /** The phone's clock: shown as "phone time, not verified". */
  deviceStartedAt: string | null;
  deviceSubmittedAt: string | null;
  voidReason: string | null;
  answers: {
    templateItemId: string;
    question: string;
    sequence: number;
    safetyCritical: boolean;
    value: string;
    comment: string | null;
  }[];
  odometerPhotos: InspectionPhotoRef[];
  itemPhotos: InspectionPhotoRef[];
};

/**
 * The supervisor's read-only view of one inspection. Every read goes through the caller's own RLS (the allocation's driver,
 * allocation.manage or reports.view for the branch); nobody else gets a row. No driver identity is read (DEC-37, DEC-41).
 * Photos are NOT opened here: each one is a separate, logged signed-URL request (can_view_evidence).
 */
export async function getInspectionDetail(
  db: Db,
  inspectionId: string,
): Promise<Outcome<{ detail: InspectionDetail }>> {
  const { data: i, error } = await db
    .from("inspections")
    .select(
      "id, inspection_stage, status, branch_id, vehicle_id, vehicle_confirmed, late_flag, safety_defect_flag, captured_offline, device_flag, completed_by_role, on_behalf_reason, new_damage_flag, known_damage_reviewed, started_at, submitted_at, device_started_at, device_submitted_at, void_reason",
    )
    .eq("id", inspectionId)
    .maybeSingle();
  if (error) return { ok: false, message: inspectionDbMessage(error) };
  if (!i) {
    return {
      ok: false,
      message: "That inspection was not found, or you cannot access it.",
    };
  }
  const [veh, resp, odo, photos, dmg] = await Promise.all([
    db
      .from("vehicles")
      .select("fleet_number, registration_number, make, model")
      .eq("id", i.vehicle_id)
      .maybeSingle(),
    db
      .from("inspection_responses")
      .select(
        "template_item_id, response_value, comment, inspection_template_items(question, sequence, severity_rule)",
      )
      .eq("inspection_id", i.id),
    db
      .from("odometer_evidence")
      .select("evidence_file_id, is_current, created_at")
      .eq("inspection_id", i.id)
      .order("created_at", { ascending: false }),
    db
      .from("inspection_photos")
      .select("evidence_file_id, template_item_id, photo_category, created_at")
      .eq("inspection_id", i.id)
      .order("created_at"),
    db.rpc("inspection_new_damage", { p_inspection_id: i.id }),
  ]);
  if (veh.error || resp.error || odo.error || photos.error || dmg.error)
    return unavailable;
  const newDamage = newDamageDoc.safeParse(dmg.data ?? []);
  if (!newDamage.success) return unavailable;
  const answers = (resp.data ?? [])
    .map((r) => {
      const it = Array.isArray(r.inspection_template_items)
        ? r.inspection_template_items[0]
        : r.inspection_template_items;
      return {
        templateItemId: r.template_item_id,
        question: it?.question ?? "",
        sequence: it?.sequence ?? 0,
        safetyCritical: it?.severity_rule === "safety_critical",
        value: r.response_value,
        comment: r.comment,
      };
    })
    .sort((a, b) => a.sequence - b.sequence);
  return {
    ok: true,
    detail: {
      id: i.id,
      stage: i.inspection_stage,
      status: i.status,
      branchId: i.branch_id,
      fleetNumber: veh.data?.fleet_number ?? "",
      registration: veh.data?.registration_number ?? "",
      make: veh.data?.make ?? "",
      model: veh.data?.model ?? "",
      vehicleConfirmed: i.vehicle_confirmed,
      lateFlag: i.late_flag,
      safetyDefectFlag: i.safety_defect_flag,
      capturedOffline: i.captured_offline,
      deviceFlag: i.device_flag,
      completedByRole: i.completed_by_role,
      onBehalfReason: i.on_behalf_reason,
      newDamageFlag: i.new_damage_flag,
      knownDamageReviewed: i.known_damage_reviewed,
      newDamage: newDamage.data,
      startedAt: i.started_at,
      submittedAt: i.submitted_at,
      deviceStartedAt: i.device_started_at,
      deviceSubmittedAt: i.device_submitted_at,
      voidReason: i.void_reason,
      answers,
      odometerPhotos: (odo.data ?? []).map((o) => ({
        evidenceFileId: o.evidence_file_id,
        isCurrent: o.is_current,
        takenAt: o.created_at,
      })),
      itemPhotos: (photos.data ?? []).map((p) => ({
        evidenceFileId: p.evidence_file_id,
        templateItemId: p.template_item_id,
        category: p.photo_category,
        takenAt: p.created_at,
      })),
    },
  };
}
