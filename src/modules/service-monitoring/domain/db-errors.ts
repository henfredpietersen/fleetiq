// Maps Postgres / PostgREST errors from the service functions to messages that are safe to show.
// Never echoes SQL text or constraint internals.
import type { PgError } from "@/modules/fleet-vehicles/domain/db-errors";

export function serviceDbMessage(e: NonNullable<PgError>): string {
  const text = `${e.message ?? ""} ${e.details ?? ""}`;
  switch (e.code) {
    case "23505":
      if (/evidence_file_id/.test(text))
        return "That photo is already attached to another service record.";
      if (/approvals_one_pending_service_config/.test(text))
        return "An override for this target is already waiting for approval.";
      return "That record already exists.";
    case "23P01":
      return "That configuration overlaps an existing one for the same target.";
    case "42501":
      if (/DEC-24|segregation|created|their own|your own/i.test(text))
        return "You cannot verify, approve or correct a record you created or requested. Someone else must do it.";
      return "You are not allowed to do this.";
    case "PGRST301":
      return "Your session has expired. Please sign in again.";
    case "P0002":
      return "That record was not found, or it is not in a branch you can access.";
    case "55000":
      if (/already waiting/i.test(text))
        return "An override for this target is already waiting for approval.";
      if (/current company default/i.test(text))
        return "These are already the current company default values.";
      if (/failed validation/i.test(text))
        return "That row failed validation and cannot be imported.";
      return "That record has already been decided or can no longer be changed.";
    case "22023":
      if (/future/i.test(text))
        return "The service date cannot be in the future.";
      if (/historical|reviewed import/i.test(text))
        return "Historical baselines come through the reviewed import only.";
      if (/evidence/i.test(text))
        return "A photo of the invoice, job card or service book is required.";
      if (/reason/i.test(text)) return "A reason is required.";
      if (/500 rows|between 1 and 500/i.test(text))
        return "An import needs between 1 and 500 rows.";
      if (/tolerance|interval/i.test(text))
        return "Check the interval and tolerances: the interval must be above 0 and each tolerance 0 or more and below the interval; a time interval needs both tolerance days.";
      return "Some of the details are not valid.";
    case "23514":
      if (/evidence/i.test(text))
        return "The photo must be service-record evidence uploaded for this company.";
      return "Some of the details are not valid.";
    default:
      return "Something went wrong on our side. Please try again.";
  }
}
