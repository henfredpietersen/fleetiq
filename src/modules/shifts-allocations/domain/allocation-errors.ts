// Maps Postgres / PostgREST errors from the allocation functions to messages that are safe to show.
// Never echoes SQL text or constraint internals.
import type { PgError } from "@/modules/fleet-vehicles/domain/db-errors";

export function allocationDbMessage(e: NonNullable<PgError>): string {
  const text = `${e.message ?? ""} ${e.details ?? ""}`;
  switch (e.code) {
    case "23P01":
      if (/driver already/i.test(text))
        return "That driver is already allocated during this period.";
      return "That vehicle is already allocated during this period.";
    case "42501":
      if (/driver cannot approve/i.test(text))
        return "The driver cannot approve their own allocation (segregation of duties).";
      if (/cannot decide your own/i.test(text))
        return "You cannot decide your own request: another manager must.";
      return "You are not allowed to do this for that branch.";
    case "PGRST301":
      return "Your session has expired. Please sign in again.";
    case "P0002":
      return "That was not found, or it is not in a branch you can access.";
    case "55000":
      if (/already (approved|rejected|cancelled)/i.test(text))
        return "That request has already been decided.";
      if (/already waiting/i.test(text))
        return "A licence override for this vehicle, driver and shift is already waiting for approval.";
      if (/not scheduled|cancelled\)/i.test(text))
        return "That shift is cancelled.";
      if (/driver is not active/i.test(text))
        return "That driver is not active.";
      return "That vehicle is not available (in maintenance, out of service, retired or archived).";
    case "23514":
      if (/no eligible licence/i.test(text))
        return "The driver has no eligible licence for this shift. This cannot be overridden.";
      if (/vehicle is not at/i.test(text))
        return "That vehicle is not at the shift's branch.";
      if (/driver is not at/i.test(text))
        return "That driver is not at the shift's branch.";
      return "Some of the details are not valid.";
    case "22023":
      if (/reason/i.test(text))
        return "A reason is required to request a licence override.";
      if (/window|end must be after/i.test(text))
        return "The planned times must lie within the shift.";
      return "Some of the details are not valid.";
    default:
      return "Something went wrong on our side. Please try again.";
  }
}
