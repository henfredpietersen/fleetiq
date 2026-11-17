// Maps Postgres / PostgREST errors from the driver and licence functions to messages that are safe to show.
// Never echoes SQL text or constraint internals.
export type PgError = {
  code?: string;
  message?: string;
  details?: string;
} | null;

export function driverDbMessage(e: NonNullable<PgError>): string {
  const text = `${e.message ?? ""} ${e.details ?? ""}`;
  switch (e.code) {
    case "42501":
      if (/created \(DEC-24\)|created.*DEC-24/i.test(text))
        return "You cannot verify a licence record you created yourself. Another administrator must do it.";
      if (/own licence/i.test(text))
        return "You cannot verify your own licence.";
      if (/own driver record/i.test(text))
        return "You cannot change the status of your own driver record.";
      return "You are not allowed to do this.";
    case "23505":
      if (/driver_licences_evidence_file_id_uq/.test(text))
        return "That photo is already attached to another licence record.";
      if (/driver_licences_no_duplicate|driver_licences_idempotent/.test(text))
        return "This licence (number and issue date) is already recorded for this driver.";
      return "That record already exists.";
    case "23514":
      if (/licence evidence/i.test(text))
        return "The attached photo is not licence evidence for this driver's branch.";
      if (/active driver/i.test(text))
        return "Licences can only be recorded for an active driver.";
      return "Some of the details are not valid. Check the dates and the PrDP expiry.";
    case "55000":
      return "This licence record has already been decided and cannot change. Record a new one if it is wrong.";
    case "P0002":
      return "That record was not found.";
    case "22023":
      return "Some of the details are not valid.";
    case "PGRST301":
      return "Your session has expired. Please sign in again.";
    default:
      return "Something went wrong on our side. Please try again.";
  }
}
