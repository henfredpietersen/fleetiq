// Input validation for the driver register and licences (DB §4; PRD §5.4). zod runs on the server in every
// action; the database CHECK / UNIQUE / trigger rules stay the final word. Normalisation mirrors them so a valid
// form never trips a CHECK (employee number canonical form = identity-access normalizeEmployeeNumber).
import { z } from "zod";
import { normalizeEmployeeNumber } from "@/modules/identity-access/domain/identifiers";
import { LICENCE_CODES } from "@/modules/shifts-allocations/domain/licence-codes";

export const uuidField = z.uuid("Invalid identifier");

const blankToUndefined = (v: unknown) =>
  typeof v === "string" && v.trim() === "" ? undefined : v;

const name = z
  .string("Enter the driver's name.")
  .trim()
  .min(1, "Enter the driver's name.")
  .max(200, "The name is too long (200 characters at most).");

const phone = z.preprocess(
  blankToUndefined,
  z.string().trim().max(40, "The phone number is too long.").optional(),
);

const date = (label: string) =>
  z
    .string(`${label} is required`)
    .regex(/^\d{4}-\d{2}-\d{2}$/, `${label} must be a date`)
    .refine(
      (v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)),
      `${label} must be a real date`,
    );

export const createDriverSchema = z.object({
  branchId: uuidField,
  employeeNumber: z.string("Enter the employee number.").transform((v, ctx) => {
    const n = normalizeEmployeeNumber(v);
    if (!n)
      ctx.addIssue({
        code: "custom",
        message:
          "Employee number: letters, digits and hyphens only, up to 20 characters.",
      });
    return n ?? "";
  }),
  displayName: name,
  phone,
});
export type CreateDriverValues = z.infer<typeof createDriverSchema>;

export const updateDriverSchema = z.object({
  driverId: uuidField,
  displayName: name,
  phone,
});

export const driverStatusSchema = z.object({
  driverId: uuidField,
  status: z.enum(["active", "inactive"]),
  reason: z
    .string("Enter a reason.")
    .trim()
    .min(1, "Enter a reason.")
    .max(500, "The reason is too long (500 characters at most)."),
});

export const licenceSchema = z
  .object({
    driverId: uuidField,
    licenceNumber: z
      .string("Enter the licence number.")
      .trim()
      .min(1, "Enter the licence number.")
      .max(50, "The licence number is too long."),
    licenceCode: z
      .string("Enter the licence code.")
      .trim()
      .min(1, "Choose the licence code.")
      .transform((v) => v.toUpperCase())
      // DEC-22: the eight codes of regulation 99 only; the database CHECK is the final word.
      .pipe(
        z.enum(LICENCE_CODES, "Choose one of A1, A, B, C1, C, EB, EC1, EC."),
      ),
    issueDate: date("Issue date"),
    expiryDate: date("Expiry date"),
    prdpRequired: z.preprocess(
      (v) => v === "on" || v === "true" || v === true,
      z.boolean(),
    ),
    prdpExpiryDate: z.preprocess(
      blankToUndefined,
      date("PrDP expiry date").optional(),
    ),
    evidenceFileId: z.preprocess(blankToUndefined, uuidField.optional()),
    clientSubmissionId: uuidField,
  })
  .superRefine((v, ctx) => {
    if (v.expiryDate <= v.issueDate)
      ctx.addIssue({
        code: "custom",
        path: ["expiryDate"],
        message: "The expiry date must be after the issue date.",
      });
    if (v.prdpRequired && !v.prdpExpiryDate)
      ctx.addIssue({
        code: "custom",
        path: ["prdpExpiryDate"],
        message: "Enter the PrDP expiry date: a PrDP is required.",
      });
  });
export type LicenceValues = z.infer<typeof licenceSchema>;

export const verifyLicenceSchema = z
  .object({
    licenceId: uuidField,
    driverId: uuidField,
    decision: z.enum(["verified", "rejected"]),
    reason: z.preprocess(
      blankToUndefined,
      z.string().trim().max(500).optional(),
    ),
  })
  .superRefine((v, ctx) => {
    if (v.decision === "rejected" && !v.reason)
      ctx.addIssue({
        code: "custom",
        path: ["reason"],
        message: "Enter a reason for rejecting this record.",
      });
  });

export const driverFilterSchema = z.object({
  q: z.preprocess(blankToUndefined, z.string().trim().max(50).optional()),
  branchId: z.preprocess(blankToUndefined, uuidField.optional()),
  status: z.preprocess(
    blankToUndefined,
    z.enum(["active", "inactive"]).optional(),
  ),
});
export type DriverFilters = z.infer<typeof driverFilterSchema>;

export function formToObject(form: FormData): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of form.entries()) if (typeof v === "string") out[k] = v;
  return out;
}

/** Turns the first zod issue per field into the list the form shows. */
export function issueMessages(error: z.ZodError): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const i of error.issues) {
    const key = i.path.join(".");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(i.message);
  }
  return out;
}
