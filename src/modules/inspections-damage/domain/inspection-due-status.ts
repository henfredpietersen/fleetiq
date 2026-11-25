// TypeScript mirror of the SQL function inspection_due_status() (migration 049; DEC-17 as amended 2026-11-24, DEC-43).
// Kept identical and tested against the shared fixture (inspection-due-status.fixture.json), which the pgTAP edge tests also follow.
// Windows come from allocation_settings(): pre-shift = planned START + preMinutes, post-shift = planned END + postMinutes, both strict.
export type DueStage = "pre_shift" | "post_shift";
export type DueStatus =
  | "not_due"
  | "due_now"
  | "overdue"
  | "submitted"
  | "submitted_late"
  | "not_applicable";

export type DueInput = {
  stage: string;
  allocationStatus: string;
  plannedStartAt: string;
  plannedEndAt: string;
  /** Server submit time of the non-void SUBMITTED inspection for the stage; null = none. */
  submittedAt: string | null;
  now: string;
  preMinutes: number;
  postMinutes: number;
};

const ms = (iso: string) => Date.parse(iso);
const minutes = (n: number) => n * 60_000;

export function inspectionIsLate(
  stage: DueStage,
  submittedAt: string,
  plannedStartAt: string,
  plannedEndAt: string,
  preMinutes: number,
  postMinutes: number,
): boolean {
  return stage === "pre_shift"
    ? ms(submittedAt) > ms(plannedStartAt) + minutes(preMinutes)
    : ms(submittedAt) > ms(plannedEndAt) + minutes(postMinutes);
}

export function inspectionDueStatus(i: DueInput): DueStatus | null {
  if (i.stage !== "pre_shift" && i.stage !== "post_shift") return null;
  const stage = i.stage;
  if (i.allocationStatus === "cancelled" || i.allocationStatus === "no_show")
    return "not_applicable";
  if (i.submittedAt !== null)
    return inspectionIsLate(
      stage,
      i.submittedAt,
      i.plannedStartAt,
      i.plannedEndAt,
      i.preMinutes,
      i.postMinutes,
    )
      ? "submitted_late"
      : "submitted";
  const now = ms(i.now);
  if (stage === "pre_shift") {
    if (
      i.allocationStatus !== "planned" &&
      i.allocationStatus !== "pre_inspection_pending"
    )
      return "not_applicable";
    if (now > ms(i.plannedStartAt) + minutes(i.preMinutes)) return "overdue";
    return now >= ms(i.plannedStartAt) ? "due_now" : "not_due";
  }
  if (
    i.allocationStatus === "planned" ||
    i.allocationStatus === "pre_inspection_pending"
  )
    return "not_due";
  if (
    i.allocationStatus !== "in_use" &&
    i.allocationStatus !== "post_inspection_pending"
  )
    return "not_applicable";
  if (now > ms(i.plannedEndAt) + minutes(i.postMinutes)) return "overdue";
  return now >= ms(i.plannedEndAt) ? "due_now" : "not_due";
}
