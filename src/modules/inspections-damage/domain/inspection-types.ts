// The shape of what the read functions return (my_inspection returns one jsonb document; it is parsed, not trusted).
import { z } from "zod";

const answer = z
  .object({ value: z.string(), comment: z.string().nullable() })
  .nullable();

export const myInspectionDoc = z.object({
  allocation_status: z.string(),
  stage: z.enum(["pre_shift", "post_shift"]),
  vehicle: z.object({
    fleet_number: z.string(),
    registration: z.string(),
    make: z.string(),
    model: z.string(),
  }),
  inspection: z
    .object({
      id: z.string(),
      status: z.enum(["draft", "submitted", "void"]),
      vehicle_confirmed: z.boolean(),
      known_damage_reviewed: z.boolean(),
      completed_by_role: z.enum(["driver", "supervisor_on_behalf"]),
      on_behalf_reason: z.string().nullable(),
      /** false for the driver while a supervisor completes the inspection on their behalf: read-only for them. */
      viewer_is_completer: z.boolean(),
      late_flag: z.boolean(),
      safety_defect_flag: z.boolean(),
      captured_offline: z.boolean(),
      started_at: z.string(),
      submitted_at: z.string().nullable(),
    })
    .nullable(),
  items: z.array(
    z.object({
      template_item_id: z.string(),
      item_key: z.string(),
      question: z.string(),
      response_type: z.enum(["ok_defect", "fuel_quarter", "yes_no_detail"]),
      required: z.boolean(),
      severity_rule: z.enum(["safety_critical", "standard"]),
      sequence: z.number(),
      allow_na: z.boolean(),
      answer,
    }),
  ),
  photo_slots: z.array(
    z.object({
      kind: z.enum(["odometer", "defect_photo"]),
      template_item_id: z.string().nullable(),
      question: z.string().optional(),
      required: z.boolean(),
      filled: z.boolean(),
    }),
  ),
  odometer_photo_present: z.boolean(),
  known_damage_reviewed: z.boolean(),
  /** DEC-42: the vehicle's open damage (reported or verified). No photos, no names. */
  known_damage: z.array(
    z.object({
      id: z.string(),
      zone: z.string(),
      zone_label: z.string(),
      severity: z.string(),
      description: z.string(),
      status: z.string(),
      reported_at: z.string(),
      source: z.string(),
      reported_now: z.boolean(),
    }),
  ),
  /** Damage reported in THIS inspection. */
  new_damage: z.array(
    z.object({
      id: z.string(),
      zone: z.string(),
      zone_label: z.string(),
      severity: z.string(),
      description: z.string(),
      reported_at: z.string(),
    }),
  ),
});
export type MyInspection = z.infer<typeof myInspectionDoc>;
export type KnownDamage = MyInspection["known_damage"][number];
export type InspectionItem = MyInspection["items"][number];

export type InspectionListRow = {
  id: string;
  allocationId: string;
  branchId: string;
  branchName: string;
  shiftDate: string;
  stage: string;
  status: string;
  fleetNumber: string;
  registration: string;
  startedAt: string;
  submittedAt: string | null;
  lateFlag: boolean;
  safetyDefectFlag: boolean;
  capturedOffline: boolean;
  completedByRole: string;
  allocationStatus: string;
  /** DEC-35: issued_device | other_device | unknown_device | no_issued_device; null while a draft. */
  deviceFlag: string | null;
  newDamageFlag: boolean;
  knownDamageReviewed: boolean;
};

/** inspection_new_damage(): damage reported in one inspection, for the supervisor (no names). */
export const newDamageDoc = z.array(
  z.object({
    id: z.string(),
    zone: z.string(),
    zone_label: z.string(),
    severity: z.string(),
    description: z.string(),
    status: z.string(),
    reported_at: z.string(),
    stage: z.string(),
    photo_ids: z.array(z.string()),
    interval: z
      .object({
        previous_allocation_id: z.string().nullable(),
        previous_allocation_planned_start_at: z.string().nullable(),
        previous_allocation_planned_end_at: z.string().nullable(),
        previous_post_shift_submitted_at: z.string().nullable(),
      })
      .nullable(),
  }),
);
export type InspectionNewDamage = z.infer<typeof newDamageDoc>[number];
