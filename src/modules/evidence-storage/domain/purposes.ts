// Evidence purposes (DB §7) and the permission that allows uploading each one.
// DEC-23 has no separate "upload evidence" permission: uploading is part of the action it supports.
// This map MUST equal public.evidence_upload_permission() in the database (checked by a unit test
// against the migration text) — the database is the authority; the app mirrors it for early, friendly errors.

export const EVIDENCE_PURPOSES = [
  "odometer",
  "inspection",
  "damage",
  "incident",
  "vehicle_document",
  "licence",
  "service_record",
] as const;
export type EvidencePurpose = (typeof EVIDENCE_PURPOSES)[number];

/** Client-declared capture sources (DEC-04). "import" exists only for server-side imports. */
export const CLIENT_CAPTURE_SOURCES = [
  "in_app_camera",
  "gallery",
  "file_upload",
] as const;
export type ClientCaptureSource = (typeof CLIENT_CAPTURE_SOURCES)[number];

export const UPLOAD_PERMISSION: Record<EvidencePurpose, string> = {
  odometer: "inspection.submit",
  inspection: "inspection.submit",
  damage: "inspection.submit",
  incident: "incident.record",
  vehicle_document: "vehicle.manage",
  licence: "driver.manage",
  service_record: "service.record.create",
};

export function isEvidencePurpose(v: unknown): v is EvidencePurpose {
  return (
    typeof v === "string" &&
    (EVIDENCE_PURPOSES as readonly string[]).includes(v)
  );
}
