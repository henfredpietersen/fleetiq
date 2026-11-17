export type EvidenceErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN" // no permission, wrong scope, or not visible (deliberately indistinguishable from not found)
  | "NOT_FOUND"
  | "INVALID_INPUT"
  | "CONFLICT" // client_submission_id reused for a different upload
  | "MIME_NOT_ALLOWED"
  | "MIME_MISMATCH" // bytes are not what the slot declared
  | "TOO_LARGE"
  | "EMPTY_FILE"
  | "INVALID_IMAGE"
  | "OBJECT_MISSING"
  | "SLOT_EXPIRED"
  | "SLOT_UNAVAILABLE"
  | "UNAVAILABLE"; // storage/database failure — retryable

export type Failure = { ok: false; code: EvidenceErrorCode; message: string };
export type Success<T> = { ok: true } & T;
export type EvidenceResult<T> = Success<T> | Failure;

export const fail = (code: EvidenceErrorCode, message: string): Failure => ({
  ok: false,
  code,
  message,
});
