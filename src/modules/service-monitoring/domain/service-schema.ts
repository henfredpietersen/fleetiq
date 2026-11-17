// Input validation for service configuration, service records and the baseline import (DB §10; PRD §5.10).
// zod runs on the server in every action; the database constraints remain the final word.
import { z } from "zod";
import { uuidField } from "@/modules/fleet-vehicles/domain/vehicle-schema";

export {
  parseInput,
  formToObject,
} from "@/modules/fleet-vehicles/domain/vehicle-schema";

const blank = (v: unknown) =>
  typeof v === "string" && v.trim() === "" ? undefined : v;

const text = (label: string, max: number) =>
  z
    .string(`${label} is required`)
    .trim()
    .min(1, `${label} is required`)
    .max(max, `${label} must be at most ${max} characters`);
const optText = (label: string, max: number) =>
  z.preprocess(
    blank,
    z
      .string()
      .trim()
      .max(max, `${label} must be at most ${max} characters`)
      .optional(),
  );

const wholeKm = (label: string) =>
  z.preprocess(
    blank,
    z.coerce
      .number(`${label} must be a number`)
      .int(`${label} must be a whole number`)
      .min(0, `${label} cannot be negative`)
      .max(2_000_000_000, `${label} is too large`),
  );
const optionalWhole = (label: string) =>
  z.preprocess(
    blank,
    z.coerce
      .number(`${label} must be a number`)
      .int(`${label} must be a whole number`)
      .min(0, `${label} cannot be negative`)
      .max(100_000, `${label} is too large`)
      .optional(),
  );
const cost = (label: string) =>
  z.preprocess(
    blank,
    z.coerce
      .number(`${label} must be a number`)
      .min(0, `${label} cannot be negative`)
      .max(100_000_000)
      .optional(),
  );

/** YYYY-MM-DD that is a real calendar date. */
export const isoDate = z
  .string("Date is required")
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the format YYYY-MM-DD")
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, "That is not a real date");

const today = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Johannesburg" }).format(
    new Date(),
  );

// ---- configuration values (shared by the company default and overrides) ----
const configValues = {
  serviceIntervalKm: wholeKm("Interval"),
  earlyToleranceKm: wholeKm("Early tolerance"),
  lateToleranceKm: wholeKm("Late tolerance"),
  serviceIntervalDays: optionalWhole("Interval days"),
  earlyToleranceDays: optionalWhole("Early tolerance days"),
  lateToleranceDays: optionalWhole("Late tolerance days"),
  manufacturerReference: optText("Manufacturer reference", 200),
  reason: text("Reason", 1000),
};

type ConfigShape = {
  serviceIntervalKm: number;
  earlyToleranceKm: number;
  lateToleranceKm: number;
  serviceIntervalDays?: number;
  earlyToleranceDays?: number;
  lateToleranceDays?: number;
};

/** Mirrors the table CHECKs (vsc_km, vsc_days) so a valid form never trips them. */
function checkConfig(v: ConfigShape, ctx: z.RefinementCtx) {
  if (v.serviceIntervalKm <= 0)
    ctx.addIssue({
      code: "custom",
      message: "The interval must be above 0 km",
      path: ["serviceIntervalKm"],
    });
  if (v.earlyToleranceKm >= v.serviceIntervalKm)
    ctx.addIssue({
      code: "custom",
      message: "Early tolerance must be below the interval",
      path: ["earlyToleranceKm"],
    });
  if (v.lateToleranceKm >= v.serviceIntervalKm)
    ctx.addIssue({
      code: "custom",
      message: "Late tolerance must be below the interval",
      path: ["lateToleranceKm"],
    });
  const days = [
    v.serviceIntervalDays,
    v.earlyToleranceDays,
    v.lateToleranceDays,
  ];
  const set = days.filter((d) => d !== undefined).length;
  // DEC-11 (Proposed): tolerance days have no built-in default; they must be entered with the interval.
  if (set !== 0 && set !== 3)
    ctx.addIssue({
      code: "custom",
      message:
        "A time interval needs interval days and both tolerance days (or leave all three empty)",
      path: ["serviceIntervalDays"],
    });
  if (v.serviceIntervalDays !== undefined && v.serviceIntervalDays <= 0)
    ctx.addIssue({
      code: "custom",
      message: "Interval days must be above 0",
      path: ["serviceIntervalDays"],
    });
}

export const changeDefaultSchema = z
  .object(configValues)
  .superRefine(checkConfig);
export type ChangeDefaultInput = z.infer<typeof changeDefaultSchema>;

export const OVERRIDE_SCOPES = ["vehicle", "make_model", "category"] as const;
export const overrideRequestSchema = z
  .object({
    scope: z.enum(
      OVERRIDE_SCOPES,
      "Choose vehicle, make and model, or category",
    ),
    vehicleId: z.preprocess(blank, uuidField.optional()),
    make: optText("Make", 100),
    model: optText("Model", 100),
    vehicleCategory: optText("Category", 100),
    ...configValues,
    clientSubmissionId: uuidField,
  })
  .superRefine((v, ctx) => {
    if (v.scope === "vehicle" && !v.vehicleId)
      ctx.addIssue({
        code: "custom",
        message: "Choose the vehicle",
        path: ["vehicleId"],
      });
    if (v.scope === "make_model" && (!v.make || !v.model))
      ctx.addIssue({
        code: "custom",
        message: "Make and model are both required",
        path: ["make"],
      });
    if (v.scope === "category" && !v.vehicleCategory)
      ctx.addIssue({
        code: "custom",
        message: "Category is required",
        path: ["vehicleCategory"],
      });
    checkConfig(v, ctx);
  })
  .transform((v) => ({
    ...v,
    // only the target fields for the chosen scope are sent (scope-consistency CHECK)
    vehicleId: v.scope === "vehicle" ? v.vehicleId : undefined,
    make: v.scope === "make_model" ? v.make : undefined,
    model: v.scope === "make_model" ? v.model : undefined,
    vehicleCategory: v.scope === "category" ? v.vehicleCategory : undefined,
  }));
export type OverrideRequestInput = z.infer<typeof overrideRequestSchema>;

export const decideOverrideSchema = z.object({
  approvalId: uuidField,
  decision: z.enum(["approved", "rejected"], "Choose approve or reject"),
  notes: optText("Notes", 1000),
});

// ---- service records ----
export const RECORD_SOURCES = ["workshop", "manual"] as const;
export const recordSchema = z.object({
  vehicleId: uuidField,
  serviceDate: isoDate.refine(
    (s) => s <= today(),
    "The service date cannot be in the future",
  ),
  odometerKm: wholeKm("Service odometer"),
  serviceType: text("Service type", 100),
  source: z
    .enum(RECORD_SOURCES, "Choose workshop or manual")
    .default("workshop"),
  supplierName: optText("Supplier", 200),
  jobReference: optText("Job reference", 100),
  invoiceReference: optText("Invoice reference", 100),
  labourCost: cost("Labour cost"),
  partsCost: cost("Parts cost"),
  totalCost: cost("Total cost"),
  evidenceFileId: z.preprocess(blank, uuidField.optional()),
  clientSubmissionId: uuidField,
});
export type RecordInput = z.infer<typeof recordSchema>;

export const verifySchema = z
  .object({
    recordId: uuidField,
    decision: z.enum(["verified", "rejected"], "Choose verify or reject"),
    reason: optText("Reason", 500),
  })
  .superRefine((v, ctx) => {
    if (v.decision === "rejected" && !v.reason)
      ctx.addIssue({
        code: "custom",
        message: "A reason is required to reject a record",
        path: ["reason"],
      });
  });

export const reverseSchema = z.object({
  recordId: uuidField,
  reason: text("Reason", 500),
});

// ---- baseline import ----
export const stageImportSchema = z.object({
  filename: text("File name", 200),
  csvText: z.string("Choose a CSV file").min(1, "The file is empty"),
  clientSubmissionId: uuidField,
});
export const attachEvidenceSchema = z.object({
  rowId: uuidField,
  batchId: uuidField,
  evidenceFileId: uuidField,
  clientSubmissionId: uuidField,
});
