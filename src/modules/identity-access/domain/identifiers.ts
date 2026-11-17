import { createHmac } from "node:crypto";

// All identifiers are keyed HMAC-SHA256 values derived with a server-only secret (AUTH_SERVER_SECRET),
// with a distinct label per purpose so one output can never stand in for another.
// - login identifier: the internal, non-deliverable Supabase Auth email of a driver (AD-08). Without
//   the secret it cannot be derived, so Supabase's public auth endpoint cannot be brute-forced directly
//   around the app's rate limiting.
// - employee-number / IP hashes: what auth_login_attempts stores (never the raw values).

export const INTERNAL_EMAIL_DOMAIN = "drivers.fleetiq.invalid";
export const MIN_SECRET_LENGTH = 32;

function mac(secret: string, label: string, ...parts: string[]): string {
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `AUTH_SERVER_SECRET must be at least ${MIN_SECRET_LENGTH} characters`,
    );
  }
  return createHmac("sha256", secret)
    .update([label, ...parts].join("\u0000"))
    .digest("hex");
}

/** Canonical employee number, or null when the input cannot be one. Case/space-insensitive. */
export function normalizeEmployeeNumber(input: string): string | null {
  const n = input.normalize("NFKC").trim().toUpperCase();
  return /^[A-Z0-9][A-Z0-9-]{0,19}$/.test(n) ? n : null;
}

export function deriveLoginIdentifier(
  secret: string,
  companyId: string,
  employeeNumber: string,
): string {
  return `d-${mac(secret, "login-id", companyId, employeeNumber).slice(0, 40)}@${INTERNAL_EMAIL_DOMAIN}`;
}

export function hashEmployeeNumber(
  secret: string,
  companyId: string,
  employeeNumber: string,
): string {
  return mac(secret, "employee-number", companyId, employeeNumber);
}

export function hashIp(secret: string, ip: string): string {
  return mac(secret, "ip", ip);
}

export function isInternalIdentifier(email: string): boolean {
  return email.trim().toLowerCase().endsWith(`@${INTERNAL_EMAIL_DOMAIN}`);
}

/** Client IP from proxy headers; falls back to a constant so unknown IPs still share one bucket. */
export function clientIpFromHeaders(
  get: (name: string) => string | null,
): string {
  const forwarded = get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || get("x-real-ip")?.trim() || "unknown";
}
