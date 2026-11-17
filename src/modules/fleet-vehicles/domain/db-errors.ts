// Maps Postgres / PostgREST errors from the vehicle + approval functions to messages that are safe to
// show. Never echoes SQL text or constraint internals.
export type PgError = {
  code?: string;
  message?: string;
  details?: string;
} | null;

export function vehicleDbMessage(e: NonNullable<PgError>): string {
  const text = `${e.message ?? ""} ${e.details ?? ""}`;
  switch (e.code) {
    case "23505":
      if (/vehicles_registration_uq|registration_number/.test(text))
        return "A vehicle with this registration number already exists.";
      if (/vehicles_fleet_number_uq|fleet_number/.test(text))
        return "A vehicle with this fleet number already exists.";
      if (/vehicles_vin_uq|\(company_id, vin\)|vin/.test(text))
        return "A vehicle with this VIN / chassis number already exists.";
      if (/approvals_one_pending_transfer|approvals_idempotent/.test(text))
        return "This vehicle already has a transfer request waiting for approval.";
      return "That record already exists.";
    case "42501":
      if (/segregation of duties/i.test(text))
        return "You cannot decide a request you made yourself. Another fleet administrator must do it.";
      return "You are not allowed to do this.";
    case "PGRST301":
      return "Your session has expired. Please sign in again.";
    case "P0002":
      return "That record was not found.";
    case "55000":
      return /archived/i.test(text)
        ? "An archived vehicle cannot be changed or transferred. Restore it first."
        : /moved since/i.test(text)
          ? "The vehicle has moved since this request was made. Reject it and request the transfer again."
          : "That request has already been decided or can no longer be changed.";
    case "22023":
      return /destination/i.test(text)
        ? "Choose a destination branch different from the current one."
        : "Some of the details are not valid.";
    case "23514":
      return "Some of the details are not valid for this company or branch.";
    default:
      return "Something went wrong on our side. Please try again.";
  }
}
