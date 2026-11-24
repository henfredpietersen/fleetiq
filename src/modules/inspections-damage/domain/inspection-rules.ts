// Inspection answer rules (PRD v1.15 §5.6–§5.7; DB v1.10 §6; DEC-21). ONE place in TypeScript, mirroring the SQL function
// public.inspection_response_valid() (migration 038), which is the final word: the database re-validates every answer.
export const INSPECTION_STAGES = ["pre_shift", "post_shift"] as const;
export type InspectionStage = (typeof INSPECTION_STAGES)[number];

export const RESPONSE_TYPES = [
  "ok_defect",
  "fuel_quarter",
  "yes_no_detail",
] as const;
export type ResponseType = (typeof RESPONSE_TYPES)[number];

/** ok_defect: ok | defect | na (na only where the item allows it); fuel_quarter: E | 1/4 | 1/2 | 3/4 | F; yes_no_detail: yes | no. */
export const RESPONSE_VALUES: Record<ResponseType, readonly string[]> = {
  ok_defect: ["ok", "defect", "na"],
  fuel_quarter: ["E", "1/4", "1/2", "3/4", "F"],
  yes_no_detail: ["yes", "no"],
};

export function isValidResponse(
  type: string,
  value: string,
  allowNa: boolean,
): boolean {
  if (!(RESPONSE_TYPES as readonly string[]).includes(type)) return false;
  const allowed = RESPONSE_VALUES[type as ResponseType];
  if (!allowed.includes(value)) return false;
  return value !== "na" || allowNa;
}

/** The options shown for an item (N/A only where the item allows it). */
export function responseOptions(
  type: ResponseType,
  allowNa: boolean,
): { value: string; label: string }[] {
  return RESPONSE_VALUES[type]
    .filter((v) => v !== "na" || allowNa)
    .map((v) => ({ value: v, label: RESPONSE_LABELS[v] ?? v }));
}

export const RESPONSE_LABELS: Record<string, string> = {
  ok: "OK",
  defect: "Defect",
  na: "N/A",
  E: "Empty",
  "1/4": "¼",
  "1/2": "½",
  "3/4": "¾",
  F: "Full",
  yes: "Yes",
  no: "No",
};

/** A Defect and a Yes both need a written comment before the inspection can be submitted (the database enforces it). */
export function needsComment(type: ResponseType, value: string | undefined) {
  return (
    (type === "ok_defect" && value === "defect") ||
    (type === "yes_no_detail" && value === "yes")
  );
}

export const STAGE_LABELS: Record<InspectionStage, string> = {
  pre_shift: "Pre-shift",
  post_shift: "Post-shift",
};
export const stageLabel = (s: string) =>
  STAGE_LABELS[s as InspectionStage] ?? s;

/** URL segment <-> stage (kebab-case in the address bar). */
export const stageFromSlug = (slug: string): InspectionStage | null =>
  slug === "pre-shift"
    ? "pre_shift"
    : slug === "post-shift"
      ? "post_shift"
      : null;
export const stageSlug = (s: InspectionStage) => s.replace("_", "-");

export const INSPECTION_STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  submitted: "Submitted",
  void: "Void",
};

export const CAMERA_LATER_TEXT = "Camera capture arrives in the next update";
