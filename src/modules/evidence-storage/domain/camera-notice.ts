// The first-use camera notice (PRD §6, DEC-29, DEC-27). The VERSION is recorded with each acknowledgement
// (camera_notice_acknowledgements, migration 044); change the text => bump the version and everyone is asked again.
// The wording is a DEFAULT to be confirmed (PR description).
export const CAMERA_NOTICE_VERSION = "2026-11-24";

export const CAMERA_NOTICE = {
  title: "Before you take photos",
  body: "Inspection photos, the odometer reading, the time and, where your phone allows it, your location are recorded for vehicle accountability. They are kept for 5 years.",
  understand: "I understand",
  later: "Not now",
} as const;
