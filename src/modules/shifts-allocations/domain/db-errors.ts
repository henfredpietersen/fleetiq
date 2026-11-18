// Maps Postgres / PostgREST errors from the shift functions to messages that are safe to show.
// Never echoes SQL text or constraint internals.
import type { PgError } from "@/modules/fleet-vehicles/domain/db-errors";

export function shiftDbMessage(e: NonNullable<PgError>): string {
  const text = `${e.message ?? ""} ${e.details ?? ""}`;
  switch (e.code) {
    case "23505":
      if (/name already exists|shift_templates/i.test(text))
        return "An active shift template with that name already exists at this branch.";
      return "That shift already exists.";
    case "42501":
      return "You are not allowed to do this for that branch.";
    case "PGRST301":
      return "Your session has expired. Please sign in again.";
    case "P0002":
      return "That was not found, or it is not in a branch you can access.";
    case "55000":
      if (/archived/i.test(text))
        return "That shift template is archived, so it can no longer be changed or used.";
      if (/active allocations/i.test(text))
        return "That shift has active allocations, so it cannot be cancelled.";
      return "That shift is cancelled and can no longer be changed.";
    case "22023":
      if (/31 days/i.test(text))
        return "At most 31 days can be generated at once.";
      if (/reason/i.test(text)) return "A reason is required.";
      if (/not active/i.test(text)) return "That department is not active.";
      if (/start and end|different end/i.test(text))
        return "The start and end time cannot be the same.";
      return "Some of the details are not valid.";
    case "23514":
      return "Some of the details are not valid.";
    default:
      return "Something went wrong on our side. Please try again.";
  }
}
