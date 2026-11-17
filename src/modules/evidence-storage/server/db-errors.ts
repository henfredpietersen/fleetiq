import "server-only";
import { fail, type Failure } from "../domain/result";

type PgError = { code?: string; message?: string } | null;

/** Maps a PostgREST/Postgres error from the evidence functions to a caller-safe failure. */
export function mapDbError(e: NonNullable<PgError>): Failure {
  switch (e.code) {
    case "42501": // insufficient_privilege: no permission / not in scope / not visible
    case "PGRST301": // JWT problems
      return fail("FORBIDDEN", "You are not allowed to do this.");
    case "EV001":
      return fail("NOT_FOUND", "Upload not found.");
    case "EV002":
      return fail(
        "SLOT_EXPIRED",
        "The upload window has expired. Start again.",
      );
    case "EV003":
      return fail(
        "SLOT_UNAVAILABLE",
        "This upload can no longer be completed.",
      );
    case "22023":
      return /already used/.test(e.message ?? "")
        ? fail(
            "CONFLICT",
            "That submission id was already used for a different upload.",
          )
        : fail("INVALID_INPUT", "Invalid request.");
    default:
      return fail(
        "UNAVAILABLE",
        "Evidence storage is temporarily unavailable.",
      );
  }
}
