// Input validation for the review actions and the settings form (PRD v1.20 §5.8; DEC-23, DEC-44). zod runs on the server before the
// SQL functions are called; the database re-checks everything and stays the final word.
import { z } from "zod";
import { uuidField } from "@/modules/fleet-vehicles/domain/vehicle-schema";

export {
  parseInput,
  formToObject,
} from "@/modules/fleet-vehicles/domain/vehicle-schema";

const note = (what: string) =>
  z
    .string()
    .trim()
    .min(1, `Add ${what} (1-500 characters).`)
    .max(500, "At most 500 characters.");

/** The list loaded validated_at as the database printed it; it is passed back UNCHANGED (a Date would lose microseconds). */
export const quickCheckSchema = z.object({
  items: z
    .array(
      z.object({
        readingId: uuidField,
        validatedAt: z.string().min(1).max(64),
      }),
    )
    .min(1, "Select at least one reading.")
    .max(50, "At most 50 readings at once."),
  clientSubmissionId: uuidField,
});

export const sendToFullSchema = z.object({
  readingId: uuidField,
  note: note("a note saying what the photo shows"),
  clientSubmissionId: uuidField,
});

export const REVIEW_DECISIONS = ["accept", "accept_value", "reject"] as const;
export const reviewSchema = z
  .object({
    readingId: uuidField,
    decision: z.enum(REVIEW_DECISIONS),
    acceptedKm: z.number().int().min(0).max(9_999_999).nullish(),
    reason: note("a reason"),
    clientSubmissionId: uuidField,
  })
  .superRefine((v, ctx) => {
    if (v.decision === "accept_value" && v.acceptedKm == null)
      ctx.addIssue({
        code: "custom",
        path: ["acceptedKm"],
        message:
          "Enter the reading shown in the photo as whole kilometres (0 to 9,999,999).",
      });
  });

const optInt = (max: number, what: string) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z.coerce
      .number({ error: `${what} must be a whole number.` })
      .int(`${what} must be a whole number.`)
      .min(0, `${what} cannot be negative.`)
      .max(max, `${what} is too large.`)
      .nullable(),
  );
const reqInt = (max: number, what: string) =>
  z.coerce
    .number({ error: `${what} must be a whole number.` })
    .int(`${what} must be a whole number.`)
    .min(0, `${what} cannot be negative.`)
    .max(max, `${what} is too large.`);

export const settingsSchema = z.object({
  vehicleCategory: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z.string().trim().min(1).max(100).nullable(),
  ),
  maxKmPerAllocation: optInt(9_999_999, "The largest plausible distance"),
  ocrMinConfidence: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z.coerce
      .number({ error: "The confidence must be a number from 0 to 1." })
      .min(0, "The confidence must be a number from 0 to 1.")
      .max(1, "The confidence must be a number from 0 to 1.")
      .nullable(),
  ),
  ocrDriverToleranceKm: reqInt(9_999_999, "The reading tolerance"),
  unaccountedToleranceKm: reqInt(
    9_999_999,
    "The unaccounted-distance tolerance",
  ),
  preShiftLateMinutes: reqInt(10_080, "The pre-shift late window"),
  postShiftLateMinutes: reqInt(10_080, "The post-shift late window"),
  staleReadingDays: reqInt(3_650, "The stale-reading period"),
  reason: z
    .string()
    .trim()
    .min(1, "A reason is required.")
    .max(500, "At most 500 characters."),
  clientSubmissionId: uuidField,
});
export type SettingsInput = z.infer<typeof settingsSchema>;
