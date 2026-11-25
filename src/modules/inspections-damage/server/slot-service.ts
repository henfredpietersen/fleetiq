import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import type { EvidenceConfig } from "@/modules/evidence-storage/domain/evidence-config";
import {
  fail,
  type EvidenceResult,
} from "@/modules/evidence-storage/domain/result";
import {
  requestUploadSlot,
  type UploadSlot,
} from "@/modules/evidence-storage/server/request-upload";
import { damageSlotSchema, parseInput } from "../domain/damage-schema";
import { photoSlotSchema } from "../domain/inspection-schema";
import * as service from "./inspection-service";

type Db = SupabaseClient<Database>;
type Deps = { db: Db; config: EvidenceConfig };

/** The in-app camera's upload slot for an inspection photo (odometer / defect). DEC-04: source and type are forced here. */
export async function requestInspectionPhotoSlot(
  deps: Deps,
  input: unknown,
): Promise<EvidenceResult<{ slot: UploadSlot }>> {
  const p = parseInput(photoSlotSchema, input);
  if (!p.ok) return fail("INVALID_INPUT", p.message);
  const b = await service.inspectionBranch(deps.db, p.value.inspectionId);
  if (!b.ok) return fail("NOT_FOUND", b.message);
  return requestUploadSlot(deps, {
    purpose: p.value.kind === "odometer" ? "odometer" : "inspection",
    branchId: b.branchId,
    captureSource: "in_app_camera",
    mimeType: "image/jpeg",
    sizeBytes: p.value.sizeBytes,
    clientSubmissionId: p.value.clientSubmissionId,
    deviceCaptureAt: p.value.deviceCaptureAt ?? null,
    location: p.value.location ?? null,
    capturedOffline: p.value.capturedOffline,
    deviceKey: p.value.deviceKey ?? null,
  });
}

/** A damage photo's slot for a draft inspection (the day-one vehicle path stays in damage-actions). */
export async function requestInspectionDamageSlot(
  deps: Deps,
  input: unknown,
): Promise<EvidenceResult<{ slot: UploadSlot }>> {
  const p = parseInput(damageSlotSchema, input);
  if (!p.ok) return fail("INVALID_INPUT", p.message);
  if (!p.value.inspectionId) return fail("INVALID_INPUT", "Invalid request.");
  const b = await service.inspectionBranch(deps.db, p.value.inspectionId);
  if (!b.ok) return fail("NOT_FOUND", b.message);
  return requestUploadSlot(deps, {
    purpose: "damage",
    branchId: b.branchId,
    captureSource: "in_app_camera",
    mimeType: "image/jpeg",
    sizeBytes: p.value.sizeBytes,
    clientSubmissionId: p.value.clientSubmissionId,
    deviceCaptureAt: p.value.deviceCaptureAt ?? null,
    location: p.value.location ?? null,
    capturedOffline: p.value.capturedOffline,
    deviceKey: p.value.deviceKey ?? null,
  });
}
