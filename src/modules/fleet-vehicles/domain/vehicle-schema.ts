// Input validation for the vehicle register (DB §4, §20; PRD §5.3). zod runs on the server in every
// action; the database CHECK/UNIQUE constraints remain the final word. Normalisation here mirrors the
// DB checks (trimmed, registration/VIN upper-case) so a valid form never trips a CHECK.
import { z } from "zod";
import type { Outcome } from "./action-state";

export const ADMIN_STATUSES = [
  "available",
  "in_maintenance",
  "out_of_service",
  "retired",
] as const; // DB §20 vehicle.administrative_status (AD-06)
export type AdminStatus = (typeof ADMIN_STATUSES)[number];

export const ADMIN_STATUS_LABELS: Record<AdminStatus, string> = {
  available: "Available",
  in_maintenance: "In maintenance",
  out_of_service: "Out of service",
  retired: "Retired",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const uuidField = z.string().regex(UUID, "Invalid identifier");

const blankToUndefined = (v: unknown) =>
  typeof v === "string" && v.trim() === "" ? undefined : v;

const required = (label: string, max: number) =>
  z
    .string(`${label} is required`)
    .trim()
    .min(1, `${label} is required`)
    .max(max, `${label} must be at most ${max} characters`);

const optional = (label: string, max: number) =>
  z.preprocess(
    blankToUndefined,
    z
      .string()
      .trim()
      .max(max, `${label} must be at most ${max} characters`)
      .optional(),
  );

const fields = {
  fleetNumber: required("Fleet number", 50),
  registrationNumber: required("Registration number", 20).transform((v) =>
    v.toUpperCase(),
  ),
  make: required("Make", 100),
  model: required("Model", 100),
  vehicleCategory: required("Category", 100),
  variant: optional("Variant", 100),
  modelYear: z.preprocess(
    blankToUndefined,
    z.coerce
      .number("Model year must be a number")
      .int("Model year must be a whole number")
      .min(1900, "Model year must be 1900 or later")
      .max(2100, "Model year must be 2100 or earlier")
      .optional(),
  ),
  vin: z.preprocess(
    blankToUndefined,
    z
      .string()
      .trim()
      .min(5, "VIN / chassis number must be at least 5 characters")
      .max(30, "VIN / chassis number must be at most 30 characters")
      .transform((v) => v.toUpperCase())
      .optional(),
  ),
  engineNumber: optional("Engine number", 50),
  fuelType: optional("Fuel type", 50),
  transmission: optional("Transmission", 50),
  administrativeStatus: z.enum(ADMIN_STATUSES, "Choose a valid status"),
};

export const createVehicleSchema = z.object({
  branchId: uuidField,
  ...fields,
  administrativeStatus: fields.administrativeStatus.default("available"),
});
export type CreateVehicleInput = z.infer<typeof createVehicleSchema>;

export const updateVehicleSchema = z.object({ id: uuidField, ...fields });
export type UpdateVehicleInput = z.infer<typeof updateVehicleSchema>;

export const archiveSchema = z.object({
  id: uuidField,
  archived: z.enum(["true", "false"]).transform((v) => v === "true"),
});

export const transferRequestSchema = z.object({
  vehicleId: uuidField,
  toBranchId: uuidField,
  reason: required("Reason", 1000),
  // idempotency (CLAUDE.md): generated once per form render, re-sent on retry
  clientSubmissionId: uuidField,
});
export type TransferRequestInput = z.infer<typeof transferRequestSchema>;

export const decisionSchema = z.object({
  approvalId: uuidField,
  decision: z.enum(["approved", "rejected"], "Choose approve or reject"),
  notes: optional("Notes", 1000),
});

export const cancelSchema = z.object({ approvalId: uuidField });

const ARCHIVE_FILTERS = ["active", "archived", "all"] as const;
export const listFilterSchema = z.object({
  // characters that would break a PostgREST or() filter are replaced, not rejected
  q: z
    .string()
    .transform((v) =>
      v
        .replace(/[,()*%\\"':]/g, " ")
        .trim()
        .slice(0, 50),
    )
    .optional(),
  branchId: uuidField.optional().catch(undefined),
  status: z.enum(ADMIN_STATUSES).optional().catch(undefined),
  archived: z.enum(ARCHIVE_FILTERS).default("active").catch("active"),
});
export type ListFilters = z.infer<typeof listFilterSchema>;

export function parseFilters(
  params: Record<string, string | string[] | undefined>,
): ListFilters {
  const first = (v: string | string[] | undefined) =>
    Array.isArray(v) ? v[0] : v;
  const r = listFilterSchema.safeParse({
    q: first(params.q),
    branchId: first(params.branch),
    status: first(params.status),
    archived: first(params.archived),
  });
  return r.success ? r.data : { archived: "active" };
}

/** zod result -> the user-facing outcome shape (first issue as the message, the rest as details). */
export function parseInput<T>(
  schema: z.ZodType<T>,
  raw: unknown,
): Outcome<{ value: T }> {
  const r = schema.safeParse(raw);
  if (r.success) return { ok: true, value: r.data };
  const messages = [...new Set(r.error.issues.map((i) => i.message))];
  return {
    ok: false,
    message: "Please correct the highlighted details.",
    details: messages,
  };
}

/** FormData -> plain object (strings only; files are never accepted here). */
export function formToObject(form: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of form.entries()) if (typeof v === "string") out[k] = v;
  return out;
}
