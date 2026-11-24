// Input validation for inspections (PRD v1.15 §5.6–§5.8). zod runs on the server in every action before the SQL functions
// are called; the database remains the final word (it re-checks everything).
import { z } from "zod";
import { uuidField } from "@/modules/fleet-vehicles/domain/vehicle-schema";
import { INSPECTION_STAGES } from "./inspection-rules";

export {
  parseInput,
  formToObject,
} from "@/modules/fleet-vehicles/domain/vehicle-schema";

const blank = (v: unknown) =>
  typeof v === "string" && v.trim() === "" ? undefined : v;
const optionalIso = z.preprocess(
  blank,
  z.string().datetime({ offset: true, message: "Invalid time" }).optional(),
);
/** DEC-06: every write carries the (untrusted) device time and whether it was captured offline. */
const deviceFields = {
  capturedOffline: z.boolean().default(false),
};
const comment = z.preprocess(
  blank,
  z
    .string()
    .trim()
    .max(1000, "A comment can be at most 1000 characters")
    .optional(),
);

export const beginSchema = z.object({
  allocationId: uuidField,
  stage: z.enum(INSPECTION_STAGES),
  deviceStartedAt: optionalIso,
  ...deviceFields,
  clientSubmissionId: uuidField,
});

export const answerSchema = z.object({
  templateItemId: uuidField,
  value: z.string().min(1, "An answer is required").max(10),
  comment,
  deviceAnsweredAt: optionalIso,
});

export const saveSchema = z.object({
  inspectionId: uuidField,
  responses: z.array(answerSchema).max(100, "At most 100 answers at once"),
  vehicleConfirmed: z.boolean().optional(),
  clientSubmissionId: uuidField,
});

export const submitSchema = z.object({
  inspectionId: uuidField,
  deviceSubmittedAt: optionalIso,
  ...deviceFields,
  clientSubmissionId: uuidField,
});

export const myInspectionSchema = z.object({
  allocationId: uuidField,
  stage: z.enum(INSPECTION_STAGES),
});

export const listInspectionsSchema = z.object({
  from: z.string().datetime({ offset: true, message: "Invalid start" }),
  to: z.string().datetime({ offset: true, message: "Invalid end" }),
  branchId: z.preprocess(blank, uuidField.optional()),
  limit: z.number().int().min(1).max(500).optional(),
});

export const PHOTO_KINDS = ["odometer", "defect"] as const;

/** Where a photo is requested from: the in-app camera only (the server forces the capture source). */
export const photoSlotSchema = z.object({
  inspectionId: uuidField,
  kind: z.enum(PHOTO_KINDS),
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
  ...deviceFields,
  deviceKey: z.string().max(64).nullable().optional(),
  clientSubmissionId: uuidField,
});

export const attachOdometerSchema = z.object({
  inspectionId: uuidField,
  evidenceFileId: uuidField,
  clientSubmissionId: uuidField,
});

export const attachDefectSchema = z.object({
  inspectionId: uuidField,
  evidenceFileId: uuidField,
  templateItemId: uuidField,
  clientSubmissionId: uuidField,
});
