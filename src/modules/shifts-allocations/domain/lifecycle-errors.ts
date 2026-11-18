// Maps errors from transition_allocation / amend_allocation_times / my_allocations to what the UI shows.
// The database writes these messages for a supervisor and marks them HINT = 'user_message': shown as is. Anything else
// falls back to the 3B mapping (which never echoes SQL text or constraint internals).
import type { PgError } from "@/modules/fleet-vehicles/domain/db-errors";
import { allocationDbMessage } from "./allocation-errors";

type E = NonNullable<PgError> & { hint?: string };

export function lifecycleDbMessage(e: E): string {
  if (e.hint === "user_message" && e.message) return e.message;
  if (e.code === "22023" && /window/i.test(e.message ?? ""))
    return "The planned times must lie within the shift.";
  if (e.code === "22023" && /end must be after/i.test(e.message ?? ""))
    return "The planned end must be after the planned start.";
  if (e.code === "PGRST301" || e.code === "42501")
    return e.code === "PGRST301"
      ? "Your session has expired. Please sign in again."
      : "You are not allowed to do this.";
  if (e.code === "P0002") return "That was not found, or you cannot access it.";
  if (e.code === "0A000") return "That step is not available yet.";
  return allocationDbMessage(e);
}
