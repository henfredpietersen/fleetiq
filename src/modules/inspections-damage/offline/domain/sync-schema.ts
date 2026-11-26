// Input validation for the offline queue's server calls (zod runs on the server before the SQL functions; the database re-checks all).
import { z } from "zod";
import { uuidField } from "@/modules/fleet-vehicles/domain/vehicle-schema";

export { parseInput } from "@/modules/fleet-vehicles/domain/vehicle-schema";

const optionalIso = z
  .string()
  .datetime({ offset: true, message: "Invalid time" })
  .nullish()
  .transform((v) => v ?? undefined);

export const SYNC_OPS = [
  "begin",
  "save",
  "confirm_known",
  "slot",
  "register",
  "attach_odometer",
  "attach_defect",
  "report_damage",
  "record_reading",
  "submit",
  "report_conflict",
  "conflict_status",
  "snapshot",
] as const;
export type SyncOpName = (typeof SYNC_OPS)[number];

export const syncEnvelope = z.object({
  op: z.enum(SYNC_OPS),
  /** The profile that created the queued work; the server refuses it under any other session. */
  profileId: uuidField,
});

export const reportSyncConflictSchema = z.object({
  allocationId: uuidField,
  inspectionId: uuidField.nullish().transform((v) => v ?? undefined),
  functionName: z.string().trim().min(1).max(60),
  refusalCode: z.string().trim().min(1).max(20),
  refusalMessage: z.string().trim().min(1).max(1000),
  deviceTime: optionalIso,
  clientSubmissionId: uuidField,
});

export const conflictStatusSchema = z.object({
  clientSubmissionIds: z.array(uuidField).min(1).max(50),
});

export const resolveSyncConflictSchema = z.object({
  id: uuidField,
  note: z
    .string()
    .trim()
    .min(1, "A note is required")
    .max(500, "At most 500 characters"),
  clientSubmissionId: uuidField,
});

export const slotKindSchema = z.enum(["odometer", "defect", "damage"]);
