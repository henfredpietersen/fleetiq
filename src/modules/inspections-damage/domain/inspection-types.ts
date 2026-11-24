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
});
export type MyInspection = z.infer<typeof myInspectionDoc>;
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
};
