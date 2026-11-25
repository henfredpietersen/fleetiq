// What the review reads return (list_odometer_review / odometer_review_detail), parsed into plain camelCase shapes.
import { z } from "zod";
import type { CheckKey, CheckResult } from "./validation";

export const CHECK_LABELS: Record<CheckKey, string> = {
  decreasing_reading: "Decreasing reading",
  implausible_distance: "Implausible distance",
  unaccounted_distance: "Unaccounted distance",
  duplicate_image: "Duplicate image",
  gallery_upload: "Photo source",
  late_inspection: "Late inspection",
};
/** Plain words for each result; "not configured" and "waiting" are neutral notes, never failures (DEC-44). */
export const RESULT_LABELS: Record<CheckResult, string> = {
  pass: "OK",
  fail: "Failed",
  not_configured: "Not configured",
  waiting: "Waiting for an earlier reading",
};
export const checkLabel = (key: string) =>
  CHECK_LABELS[key as CheckKey] ?? key.replace(/_/g, " ");

const checkDoc = z.object({
  key: z.string(),
  result: z.enum(["pass", "fail", "not_configured", "waiting"]),
  note: z
    .string()
    .nullish()
    .transform((v) => v ?? ""),
  values: z
    .record(z.string(), z.unknown())
    .nullish()
    .transform((v) => v ?? {}),
});
export const checksDoc = z.array(checkDoc);
export type CheckView = z.infer<typeof checkDoc>;

export type ReviewRow = {
  readingId: string;
  validatedAt: string | null;
  branchId: string;
  branchName: string;
  vehicleId: string;
  fleetNumber: string;
  registration: string;
  inspectionId: string;
  allocationId: string;
  stage: "pre_shift" | "post_shift";
  plannedStartAt: string;
  plannedEndAt: string;
  driverReadingKm: number | null;
  /** null unless the viewer may see the driver register (DEC-37 / DEC-41). */
  driverName: string | null;
  evidenceFileId: string | null;
  capturedOffline: boolean;
  lateFlag: boolean;
  submittedAt: string;
  reviewKind: "quick_check" | "full";
  checks: CheckView[];
  failedChecks: string[];
  fullReviewNote: string | null;
  previousAcceptedKm: number | null;
  previousAcceptedAt: string | null;
  /** DEC-24: why THIS viewer may not check or decide it (null = they may). */
  blockedReason: string | null;
  canDecide: boolean;
};

export type ItemResult = {
  readingId: string | null;
  result: "accepted" | "refused";
  code?: string;
  message?: string;
};

export const quickCheckReply = z.object({
  results: z.array(
    z.object({
      reading_id: z.string().nullable(),
      result: z.enum(["accepted", "refused"]),
      code: z.string().optional(),
      message: z.string().optional(),
    }),
  ),
  accepted: z.number(),
  refused: z.number(),
});

export const detailDoc = z.object({
  status: z.string(),
  exceptions: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      severity: z.string(),
      description: z.string(),
      status: z.string(),
      resolution_summary: z.string().nullable(),
    }),
  ),
  events: z.array(
    z.object({
      type: z.string(),
      reason: z.string().nullable(),
      occurred_at: z.string(),
    }),
  ),
});
export type ReadingDetail = z.infer<typeof detailDoc>;
