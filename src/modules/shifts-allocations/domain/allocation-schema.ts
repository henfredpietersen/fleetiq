// Input validation for allocations (PRD v1.12 §5.5; DEC-22). zod runs on the server in every action before the SQL
// functions are called; the database remains the final word (it re-checks everything).
import { z } from "zod";
import { uuidField } from "@/modules/fleet-vehicles/domain/vehicle-schema";
import { LICENCE_CODES } from "./licence-codes";

export {
  parseInput,
  formToObject,
} from "@/modules/fleet-vehicles/domain/vehicle-schema";

const blank = (v: unknown) =>
  typeof v === "string" && v.trim() === "" ? undefined : v;

const optionalReason = z.preprocess(
  blank,
  z
    .string()
    .trim()
    .max(1000, "The reason must be at most 1000 characters")
    .optional(),
);

/** Ask the database whether a shift + vehicle + driver combination is allowed, before submitting. */
export const eligibilitySchema = z.object({
  shiftId: uuidField,
  vehicleId: uuidField,
  driverId: uuidField,
});

/** Planned times are not sent from the UI: they default to the shift's scheduled times in the database. */
export const requestAllocationSchema = z.object({
  shiftId: uuidField,
  vehicleId: uuidField,
  driverId: uuidField,
  reason: optionalReason,
  clientSubmissionId: uuidField,
});

export const decideOverrideSchema = z.object({
  approvalId: uuidField,
  decision: z.enum(["approved", "rejected"], "Choose approve or reject"),
  notes: z.preprocess(
    blank,
    z
      .string()
      .trim()
      .max(1000, "The notes must be at most 1000 characters")
      .optional(),
  ),
});

/** An empty code clears the requirement ("not configured"). */
export const requiredLicenceCodeSchema = z.object({
  vehicleId: uuidField,
  code: z.preprocess(
    blank,
    z.enum(LICENCE_CODES, "Choose one of the licence codes").optional(),
  ),
  reason: z
    .string("A reason is required")
    .trim()
    .min(1, "A reason is required")
    .max(500, "The reason must be at most 500 characters"),
});

export const boardFilterSchema = z.object({
  branchId: z.preprocess(blank, uuidField.optional()),
  date: z.preprocess(blank, z.iso.date().optional()),
});

const requiredReason = z
  .string("A reason is required")
  .trim()
  .min(1, "A reason is required")
  .max(500, "The reason must be at most 500 characters");

/** Start (own driver: no reason; on behalf: reason required, enforced by the database), cancel and no-show. */
export const transitionSchema = z.object({
  allocationId: uuidField,
  toStatus: z.enum(["pre_inspection_pending", "cancelled", "no_show"]),
  reason: z.preprocess(blank, requiredReason.optional()),
  clientSubmissionId: uuidField,
});
export const cancelSchema = transitionSchema.extend({
  toStatus: z.literal("cancelled"),
  reason: requiredReason,
});
export const noShowSchema = transitionSchema.extend({
  toStatus: z.literal("no_show"),
  reason: requiredReason,
});

export const amendSchema = z
  .object({
    allocationId: uuidField,
    plannedStartAt: z.iso.datetime({ offset: true }),
    plannedEndAt: z.iso.datetime({ offset: true }),
    reason: requiredReason,
    clientSubmissionId: uuidField,
  })
  .refine((v) => new Date(v.plannedEndAt) > new Date(v.plannedStartAt), {
    message: "The end must be after the start",
    path: ["plannedEndAt"],
  });

export const myAllocationsSchema = z.object({
  from: z.iso.datetime({ offset: true }),
  to: z.iso.datetime({ offset: true }),
});

export const amendCheckSchema = z.object({
  allocationId: uuidField,
  plannedStartAt: z.iso.datetime({ offset: true }),
  plannedEndAt: z.iso.datetime({ offset: true }),
});
