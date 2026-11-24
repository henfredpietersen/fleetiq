// The known-damage register's fixed vocabulary (DEC-42): zones, severities, statuses. ONE place in TypeScript, mirroring the SQL
// functions public.damage_zones() / damage_zone_label() and the status CHECKs (migration 046); damage-zones.test.ts compares this
// file with the migration text so the two cannot drift. The database stays the final word.
export const DAMAGE_ZONES = [
  "front_bumper",
  "bonnet",
  "windscreen",
  "roof",
  "rear_bumper",
  "rear_boot_load_area",
  "left_front",
  "left_rear",
  "right_front",
  "right_rear",
  "wheels_tyres",
  "interior",
  "other",
] as const;
export type DamageZone = (typeof DAMAGE_ZONES)[number];

/** Plain-words display names (the same strings as damage_zone_label()). */
export const DAMAGE_ZONE_LABELS: Record<DamageZone, string> = {
  front_bumper: "Front bumper",
  bonnet: "Bonnet",
  windscreen: "Windscreen",
  roof: "Roof",
  rear_bumper: "Rear bumper",
  rear_boot_load_area: "Rear (boot or load area)",
  left_front: "Left front (door and wing)",
  left_rear: "Left rear (door and wing)",
  right_front: "Right front (door and wing)",
  right_rear: "Right rear (door and wing)",
  wheels_tyres: "Wheels and tyres",
  interior: "Interior",
  other: "Other",
};
export const zoneLabel = (z: string) =>
  DAMAGE_ZONE_LABELS[z as DamageZone] ?? z;

export const DAMAGE_SEVERITIES = ["minor", "moderate", "major"] as const;
export type DamageSeverity = (typeof DAMAGE_SEVERITIES)[number];
export const SEVERITY_LABELS: Record<DamageSeverity, string> = {
  minor: "Minor",
  moderate: "Moderate",
  major: "Major",
};
export const severityLabel = (s: string) =>
  SEVERITY_LABELS[s as DamageSeverity] ?? s;

/** reported -> verified | disputed; verified -> repaired. disputed and repaired are final. */
export const DAMAGE_STATUSES = [
  "reported",
  "verified",
  "disputed",
  "repaired",
] as const;
export type DamageStatus = (typeof DAMAGE_STATUSES)[number];
export const DAMAGE_STATUS_LABELS: Record<DamageStatus, string> = {
  reported: "Reported",
  verified: "Verified",
  disputed: "Disputed",
  repaired: "Repaired",
};
export const damageStatusLabel = (s: string) =>
  DAMAGE_STATUS_LABELS[s as DamageStatus] ?? s;

const NEXT: Record<DamageStatus, readonly DamageStatus[]> = {
  reported: ["verified", "disputed"],
  verified: ["repaired"],
  disputed: [],
  repaired: [],
};
export const damageTransitionAllowed = (from: string, to: string) =>
  (NEXT[from as DamageStatus] ?? []).includes(to as DamageStatus);
export const isFinalDamageStatus = (s: string) =>
  s === "disputed" || s === "repaired";
/** Open = still part of the vehicle's known damage (shown to drivers). */
export const isOpenDamageStatus = (s: string) =>
  s === "reported" || s === "verified";

export const DESCRIPTION_MAX = 500;
export const MAX_DAMAGE_PHOTOS = 10;
