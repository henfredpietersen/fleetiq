// Input validation for shift templates and shifts (DB v1.6 §5; PRD v1.11 §5.5). zod runs on the server in every
// action before the SQL functions are called; the database constraints remain the final word.
import { z } from "zod";
import { uuidField } from "@/modules/fleet-vehicles/domain/vehicle-schema";
import { isoDate } from "@/modules/service-monitoring/domain/service-schema";
import { inclusiveDays, TIME_PATTERN } from "./shift-times";

export {
  parseInput,
  formToObject,
} from "@/modules/fleet-vehicles/domain/vehicle-schema";

export const MAX_GENERATE_DAYS = 31;

const blank = (v: unknown) =>
  typeof v === "string" && v.trim() === "" ? undefined : v;

const name = z
  .string("A name is required")
  .trim()
  .min(1, "A name is required")
  .max(100, "The name must be at most 100 characters");
const reason = (what: string) =>
  z
    .string(`A reason is required to ${what}`)
    .trim()
    .min(1, `A reason is required to ${what}`)
    .max(500, "The reason must be at most 500 characters");
/** HH:MM, 24-hour. */
const time = (label: string) =>
  z
    .string(`${label} is required`)
    .regex(TIME_PATTERN, `${label} must be a time like 06:00`);

const differentTimes = <T extends { startTime: string; endTime: string }>(
  v: T,
) => v.startTime !== v.endTime;
const DIFFERENT = {
  message: "The start and end time cannot be the same",
  path: ["endTime"],
};

export const templateSchema = z
  .object({
    branchId: uuidField,
    name,
    startTime: time("Start time"),
    endTime: time("End time"),
  })
  .refine(differentTimes, DIFFERENT);

export const updateTemplateSchema = z
  .object({
    templateId: uuidField,
    name,
    startTime: time("Start time"),
    endTime: time("End time"),
  })
  .refine(differentTimes, DIFFERENT);

export const archiveTemplateSchema = z.object({
  templateId: uuidField,
  reason: reason("archive a shift template"),
});

export const generateSchema = z
  .object({
    templateId: uuidField,
    from: isoDate,
    to: isoDate,
    clientSubmissionId: uuidField,
  })
  .refine((v) => v.to >= v.from, {
    message: "The end date cannot be before the start date",
    path: ["to"],
  })
  .refine(
    (v) => {
      try {
        return inclusiveDays(v.from, v.to) <= MAX_GENERATE_DAYS;
      } catch {
        return true; // an invalid date is already reported by its own field
      }
    },
    {
      message: `At most ${MAX_GENERATE_DAYS} days can be generated at once`,
      path: ["to"],
    },
  );

export const adHocShiftSchema = z
  .object({
    branchId: uuidField,
    departmentId: z.preprocess(blank, uuidField.optional()),
    shiftDate: isoDate,
    startTime: time("Start time"),
    endTime: time("End time"),
    clientSubmissionId: uuidField,
  })
  .refine(differentTimes, DIFFERENT);

export const cancelShiftSchema = z.object({
  shiftId: uuidField,
  reason: reason("cancel a shift"),
});

/** Date-range filter for the shifts list (dates are Africa/Johannesburg shift dates). */
export const shiftFilterSchema = z
  .object({
    branchId: z.preprocess(blank, uuidField.optional()),
    from: z.preprocess(blank, isoDate.optional()),
    to: z.preprocess(blank, isoDate.optional()),
  })
  .refine((v) => !v.from || !v.to || v.to >= v.from, {
    message: "The end date cannot be before the start date",
    path: ["to"],
  });
