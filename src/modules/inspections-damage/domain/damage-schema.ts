// Input validation for the damage register and the on-behalf flow (DEC-42, DEC-09). zod runs on the server in every action before
// the SQL functions are called; the database re-checks everything and stays the final word.
import { z } from "zod";
import { uuidField } from "@/modules/fleet-vehicles/domain/vehicle-schema";
import {
  DAMAGE_SEVERITIES,
  DAMAGE_ZONES,
  DESCRIPTION_MAX,
  MAX_DAMAGE_PHOTOS,
} from "./damage-zones";

export { parseInput } from "@/modules/fleet-vehicles/domain/vehicle-schema";

const blank = (v: unknown) =>
  typeof v === "string" && v.trim() === "" ? undefined : v;
const optionalIso = z.preprocess(
  blank,
  z.string().datetime({ offset: true, message: "Invalid time" }).optional(),
);
const zone = z.enum(DAMAGE_ZONES, { message: "Choose where the damage is" });
const severity = z.enum(DAMAGE_SEVERITIES, {
  message: "Choose how serious the damage is",
});
const description = z
  .string()
  .trim()
  .min(1, "Describe the damage")
  .max(DESCRIPTION_MAX, `At most ${DESCRIPTION_MAX} characters`);
const photos = z
  .array(uuidField)
  .min(1, "Take at least one photo")
  .max(MAX_DAMAGE_PHOTOS, `At most ${MAX_DAMAGE_PHOTOS} photos`)
  .refine((a) => new Set(a).size === a.length, "Each photo only once");
const reason = z
  .string()
  .trim()
  .min(1, "A reason is required")
  .max(500, "At most 500 characters");

export const reportDamageSchema = z.object({
  inspectionId: uuidField,
  zone,
  severity,
  description,
  evidenceFileIds: photos,
  deviceReportedAt: optionalIso,
  capturedOffline: z.boolean().default(false),
  clientSubmissionId: uuidField,
});
export const onboardingDamageSchema = z.object({
  vehicleId: uuidField,
  zone,
  severity,
  description,
  evidenceFileIds: photos,
  clientSubmissionId: uuidField,
});
export const confirmKnownDamageSchema = z.object({
  inspectionId: uuidField,
  clientSubmissionId: uuidField,
});
export const reviewDamageSchema = z
  .object({
    itemId: uuidField,
    decision: z.enum(["verified", "disputed"]),
    reason: z.preprocess(blank, reason.optional()),
    clientSubmissionId: uuidField,
  })
  .refine((v) => v.decision !== "disputed" || !!v.reason, {
    message: "A reason is required to dispute a damage report",
    path: ["reason"],
  });
export const repairDamageSchema = z.object({
  itemId: uuidField,
  note: reason.refine(() => true),
  clientSubmissionId: uuidField,
});
export const beginOnBehalfSchema = z.object({
  allocationId: uuidField,
  reason,
  deviceStartedAt: optionalIso,
  capturedOffline: z.boolean().default(false),
  clientSubmissionId: uuidField,
});
export const damageSlotSchema = z.object({
  /** Exactly one of the two: a draft inspection, or (onboarding) a vehicle. */
  inspectionId: z.preprocess(blank, uuidField.optional()),
  vehicleId: z.preprocess(blank, uuidField.optional()),
  sizeBytes: z.number().int().min(1),
  deviceCaptureAt: optionalIso,
  location: z
    .object({
      latitude: z.number(),
      longitude: z.number(),
      accuracyM: z.number().nullable().optional(),
    })
    .nullable()
    .optional(),
  capturedOffline: z.boolean().default(false),
  deviceKey: z.string().max(64).nullable().optional(),
  clientSubmissionId: uuidField,
});
