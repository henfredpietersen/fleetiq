// Maps errors from the inspection functions to what the UI shows. The database writes these messages for the person using the
// app and marks them HINT = 'user_message': shown as is. Anything else falls back to a generic line; SQL text and constraint
// names are never echoed.
import type { PgError } from "@/modules/fleet-vehicles/domain/db-errors";

type E = NonNullable<PgError> & { hint?: string };

export function inspectionDbMessage(e: E): string {
  if (e.hint === "user_message" && e.message) return e.message;
  if (e.code === "PGRST301")
    return "Your session has expired. Please sign in again.";
  if (e.code === "42501") return "You are not allowed to do this.";
  if (e.code === "P0002") return "That was not found, or you cannot access it.";
  if (e.code === "22023")
    return "Some of that could not be accepted. Check it and try again.";
  return "Something went wrong on our side. Please try again.";
}
