import { randomUUID } from "node:crypto";
import {
  DEFAULT_EVIDENCE_CONFIG,
  type EvidenceConfig,
} from "../../src/modules/evidence-storage/domain/evidence-config";
import { jpeg } from "../../src/modules/evidence-storage/domain/fixtures";
import { registerUpload } from "../../src/modules/evidence-storage/server/register-upload";
import { requestUploadSlot } from "../../src/modules/evidence-storage/server/request-upload";
import { admin, type Db } from "./helpers";

// SYNTHETIC onboarding damage for a vehicle (DEC-42 day-one load). A damage report needs at least one photo, so the seed cannot be
// plain SQL without a fake photo file: this helper does what the app does, as a real signed-in supervisor on LOCAL Supabase —
// request a slot, upload a GENERATED JPEG (a few bytes, not a photograph), register it, then call record_onboarding_damage().
// It is used by CI tests (never by seed.sql) and can be run against a local database to demo the register.
export const SYNTHETIC_ONBOARDING_DAMAGE = [
  {
    zone: "left_front",
    severity: "minor",
    description: "Synthetic example: light scratch on the left front door",
  },
  {
    zone: "rear_bumper",
    severity: "moderate",
    description: "Synthetic example: crack in the rear bumper corner",
  },
] as const;

const config: EvidenceConfig = { ...DEFAULT_EVIDENCE_CONFIG };

/** `supervisor` is a signed-in client of someone holding allocation.manage and inspection.submit for the vehicle's branch. */
export async function seedOnboardingDamage(
  supervisor: Db,
  vehicleId: string,
  branchId: string,
  items: readonly {
    zone: string;
    severity: string;
    description: string;
  }[] = SYNTHETIC_ONBOARDING_DAMAGE,
): Promise<string[]> {
  const ids: string[] = [];
  for (const it of items) {
    const body = jpeg({});
    const slot = await requestUploadSlot(
      { db: supervisor, config },
      {
        purpose: "damage",
        branchId,
        captureSource: "in_app_camera",
        mimeType: "image/jpeg",
        sizeBytes: body.length,
        clientSubmissionId: randomUUID(),
      },
    );
    if (!slot.ok) throw new Error(`slot: ${slot.message}`);
    if (slot.slot.uploadUrl && slot.slot.token) {
      const up = await supervisor.storage
        .from(slot.slot.bucket)
        .uploadToSignedUrl(
          slot.slot.objectPath,
          slot.slot.token,
          new Blob([body as BlobPart], { type: "image/jpeg" }),
          { contentType: "image/jpeg" },
        );
      if (up.error) throw up.error;
    }
    const reg = await registerUpload(
      { db: supervisor, admin: () => admin(), config },
      { slotId: slot.slot.slotId },
    );
    if (!reg.ok) throw new Error(`register: ${reg.message}`);
    const { data, error } = await supervisor.rpc("record_onboarding_damage", {
      p_vehicle_id: vehicleId,
      p_zone: it.zone,
      p_severity: it.severity,
      p_description: it.description,
      p_evidence_file_ids: [reg.evidence.evidenceFileId],
      p_client_submission_id: randomUUID(),
    });
    if (error) throw error;
    ids.push(data as string);
  }
  return ids;
}
