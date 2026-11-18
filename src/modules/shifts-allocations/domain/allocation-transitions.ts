// The allocation status graph (PRD v1.13 §5.5, DB v1.8 §20). Pure mirror of the SQL function
// public.allocation_transition_allowed(from, to): the SQL is authoritative and enforces it in the database; both are tested
// against allocation-transitions.fixture.json (all 64 pairs). The UI uses this only to decide which actions to offer.
export const ALLOCATION_STATUSES = [
  "planned",
  "pre_inspection_pending",
  "in_use",
  "post_inspection_pending",
  "closed",
  "closed_with_exceptions",
  "cancelled",
  "no_show",
] as const;
export type AllocationStatus = (typeof ALLOCATION_STATUSES)[number];

const ALLOWED: Record<AllocationStatus, readonly AllocationStatus[]> = {
  planned: ["pre_inspection_pending", "cancelled"],
  pre_inspection_pending: ["in_use", "no_show", "cancelled"],
  in_use: ["post_inspection_pending"],
  post_inspection_pending: ["closed", "closed_with_exceptions"],
  closed_with_exceptions: ["closed"],
  closed: [],
  cancelled: [],
  no_show: [],
};

export function isAllocationStatus(v: unknown): v is AllocationStatus {
  return (
    typeof v === "string" &&
    (ALLOCATION_STATUSES as readonly string[]).includes(v)
  );
}

/** True when the status graph allows from -> to. Null, unknown or wrongly-cased values allow nothing. */
export function allocationTransitionAllowed(
  from: string | null | undefined,
  to: string | null | undefined,
): boolean {
  if (!isAllocationStatus(from) || !isAllocationStatus(to)) return false;
  return ALLOWED[from].includes(to);
}
