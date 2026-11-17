import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";

type Client = SupabaseClient<Database>;

export type EnrolmentStart =
  | { ok: true; factorId: string; qrCode: string; secret: string }
  | { ok: false };

/** Starts TOTP enrolment (DEC-34). Stale unverified factors are removed first so retries stay clean. */
export async function startTotpEnrolment(
  supabase: Client,
): Promise<EnrolmentStart> {
  const { data: factors } = await supabase.auth.mfa.listFactors();
  for (const f of factors?.all ?? []) {
    if (f.factor_type === "totp" && f.status === "unverified")
      await supabase.auth.mfa.unenroll({ factorId: f.id });
  }
  const { data, error } = await supabase.auth.mfa.enroll({
    factorType: "totp",
    friendlyName: `FleetIQ authenticator ${new Date().toISOString()}`,
  });
  if (error || !data) return { ok: false };
  return {
    ok: true,
    factorId: data.id,
    qrCode: data.totp.qr_code,
    secret: data.totp.secret,
  };
}

export async function verifiedTotpFactorId(
  supabase: Client,
): Promise<string | null> {
  const { data } = await supabase.auth.mfa.listFactors();
  return data?.totp[0]?.id ?? null; // `totp` lists verified factors only
}

export type TotpVerification =
  { ok: true } | { ok: false; code: "invalid_code" | "service_error" };

/** Challenge + verify. On success Supabase upgrades the session to AAL2 and the cookies are refreshed. */
export async function verifyTotp(
  supabase: Client,
  factorId: string,
  code: string,
): Promise<TotpVerification> {
  if (!/^\d{6}$/.test(code)) return { ok: false, code: "invalid_code" };
  const { data: challenge, error: cError } = await supabase.auth.mfa.challenge({
    factorId,
  });
  if (cError || !challenge) return { ok: false, code: "service_error" };
  const { error } = await supabase.auth.mfa.verify({
    factorId,
    challengeId: challenge.id,
    code,
  });
  if (error)
    return {
      ok: false,
      code:
        error.code === "mfa_verification_failed"
          ? "invalid_code"
          : "service_error",
    };
  return { ok: true };
}
