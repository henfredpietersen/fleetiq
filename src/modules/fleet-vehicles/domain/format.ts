import {
  ADMIN_STATUSES,
  ADMIN_STATUS_LABELS,
  type AdminStatus,
} from "./vehicle-schema";

const TZ = "Africa/Johannesburg"; // company timezone (CONTEXT.md)

export function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("en-ZA", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: TZ,
  }).format(d);
}

export function statusLabel(status: string): string {
  return (ADMIN_STATUSES as readonly string[]).includes(status)
    ? ADMIN_STATUS_LABELS[status as AdminStatus]
    : status;
}
