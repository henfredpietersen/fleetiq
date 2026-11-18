// Plain-words text for allocation results (DEC-22). One place, used by the allocate dialog and the board.
export type EligibilityResult = {
  ok: boolean;
  blockReasons: string[];
  licenceClassCheck: string | null;
  needsOverride: boolean;
};

const REASON_TEXT: Record<string, string> = {
  shift_not_scheduled:
    "This shift is cancelled, so nothing can be allocated to it.",
  vehicle_not_available:
    "This vehicle is not available (in maintenance, out of service, retired or archived).",
  vehicle_wrong_branch: "This vehicle is not at the shift's branch.",
  driver_inactive: "This driver is not active.",
  driver_wrong_branch: "This driver is not at the shift's branch.",
  no_eligible_licence:
    "This driver has no eligible licence: it must be verified and valid until the end of the shift (and have a valid PrDP where one is required). This cannot be overridden.",
  vehicle_conflict: "This vehicle is already allocated during this shift.",
  driver_conflict: "This driver is already allocated during this shift.",
};

export function blockReasonText(code: string): string {
  return REASON_TEXT[code] ?? "This combination is not allowed.";
}

/** The sentences shown before submitting; the first tells the user what will happen. */
export function explainEligibility(r: EligibilityResult): {
  tone: "ok" | "warning" | "blocked";
  lines: string[];
} {
  if (!r.ok)
    return { tone: "blocked", lines: r.blockReasons.map(blockReasonText) };
  if (r.needsOverride)
    return {
      tone: "warning",
      lines: [
        "The driver's licence is valid, but its class does not cover this vehicle. The allocation will not be created yet: it is sent for approval to another manager, and you must give a reason.",
      ],
    };
  if (r.licenceClassCheck === "not_configured")
    return {
      tone: "ok",
      lines: [
        "Allowed. This vehicle has no required licence code, so the licence class is not checked (this is recorded on the allocation).",
      ],
    };
  return {
    tone: "ok",
    lines: ["Allowed. The driver's licence is valid and covers this vehicle."],
  };
}

export function licenceCheckLabel(check: string): {
  label: string;
  variant: "success" | "warning" | "default";
} {
  switch (check) {
    case "matched":
      return { label: "Licence matched", variant: "success" };
    case "override_approved":
      return { label: "Licence override approved", variant: "warning" };
    default:
      return { label: "Licence class not checked", variant: "default" };
  }
}

const STATUS_LABEL: Record<string, string> = {
  planned: "Planned",
  pre_inspection_pending: "Pre-inspection pending",
  in_use: "In use",
  post_inspection_pending: "Post-inspection pending",
  closed: "Closed",
  closed_with_exceptions: "Closed with exceptions",
  cancelled: "Cancelled",
  no_show: "No-show",
};
export const allocationStatusLabel = (s: string) => STATUS_LABEL[s] ?? s;
