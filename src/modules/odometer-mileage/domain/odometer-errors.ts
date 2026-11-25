// The error codes of the odometer review functions (migration 052 odometer_messages() is the SQL catalogue; this mirrors it so the UI can
// map a code without a round trip). The database writes the message for the person using the app and marks it HINT = 'user_message':
// shown as is. IN015 (driver entry) and IN006 live with the inspection errors.
export const OD_MESSAGES: Record<string, string> = {
  OD001: "You are not allowed to check this reading.",
  OD002: "That reading was not found, or you cannot access it.",
  OD003: "This reading is no longer waiting for review.",
  OD004:
    "This reading changed after you opened the list. Reload the list and check it again.",
  OD005: "This reading belongs in the other review queue.",
  OD006:
    "You cannot check or decide a reading you entered, from an inspection you completed, or on an allocation where you are the driver. Ask another supervisor.",
  OD007: "Add a note (1-500 characters) saying why.",
  OD008:
    "Enter the reading shown in the photo as whole kilometres, using digits only (0 to 9,999,999).",
  OD009:
    'That is the same as the reading the driver typed. Choose "Accept the driver\'s reading" instead.',
  OD010: "That request could not be understood. Reload the page and try again.",
  OD011: "An accepted reading already exists for this stage of the allocation.",
};

type E = { code?: string; message?: string; hint?: string | null };

/** What to show for a database refusal of a review call. */
export function odometerDbMessage(e: E): string {
  if (e.hint === "user_message" && e.message) return e.message;
  if (e.code && OD_MESSAGES[e.code]) return OD_MESSAGES[e.code]!;
  if (e.code === "PGRST301")
    return "Your session has expired. Please sign in again.";
  if (e.code === "42501") return "You are not allowed to do this.";
  if (e.code === "P0002") return "That was not found, or you cannot access it.";
  if (e.code === "22023")
    return "Some of that could not be accepted. Check it and try again.";
  return "Something went wrong on our side. Please try again.";
}
