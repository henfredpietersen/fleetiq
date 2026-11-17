import { createHmac, timingSafeEqual } from "node:crypto";
import type { SessionConfig } from "./auth-config";

// App-level absolute session lifetime per user type, on top of Supabase's server-side timebox/inactivity.
// The sign-in time travels in a signed cookie so it cannot be extended by editing it.

export const SESSION_START_COOKIE = "fleetiq_session_start";

export type SessionKind = "driver" | "staff";

function sign(
  secret: string,
  userId: string,
  kind: SessionKind,
  startedAtMs: number,
): string {
  return createHmac("sha256", secret)
    .update(`session-start\u0000${userId}\u0000${kind}\u0000${startedAtMs}`)
    .digest("hex");
}

export function createSessionStartValue(
  secret: string,
  userId: string,
  kind: SessionKind,
  startedAt: Date,
): string {
  const ms = startedAt.getTime();
  return `${kind}.${ms}.${sign(secret, userId, kind, ms)}`;
}

export type SessionStart = { kind: SessionKind; startedAtMs: number };

/** Returns the verified start, or null when missing, malformed, forged or for another user. */
export function readSessionStartValue(
  secret: string,
  userId: string,
  value: string | undefined,
): SessionStart | null {
  if (!value) return null;
  const [kind, msRaw, sig] = value.split(".");
  if (
    (kind !== "driver" && kind !== "staff") ||
    !msRaw ||
    !sig ||
    !/^\d{1,16}$/.test(msRaw)
  )
    return null;
  const ms = Number(msRaw);
  const expected = Buffer.from(sign(secret, userId, kind, ms), "hex");
  const given = Buffer.from(sig, "hex");
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    return null;
  return { kind, startedAtMs: ms };
}

export function maxAgeMs(kind: SessionKind, cfg: SessionConfig): number {
  return (
    (kind === "driver" ? cfg.driverMaxAgeHours : cfg.staffMaxAgeHours) *
    3_600_000
  );
}

export function isSessionExpired(
  start: SessionStart,
  now: Date,
  cfg: SessionConfig,
): boolean {
  const age = now.getTime() - start.startedAtMs;
  return age < 0 || age >= maxAgeMs(start.kind, cfg);
}
