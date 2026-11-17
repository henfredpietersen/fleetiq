"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { loadAuthConfig } from "../domain/auth-config";
import { clientIpFromHeaders } from "../domain/identifiers";
import { describePinViolations } from "../domain/pin-rules";
import { formatRetry } from "../domain/lockout";
import {
  createSessionStartValue,
  maxAgeMs,
  SESSION_START_COOKIE,
  type SessionKind,
} from "../domain/session-policy";
import type { ActionState } from "../ui/action-state";
import { authSecret, createDriverAuth } from "./factory";
import { startTotpEnrolment, verifiedTotpFactorId, verifyTotp } from "./mfa";
import { getSessionContext, stepFor } from "./session";
import { staffSignIn } from "./staff-auth";

const GENERIC_SIGN_IN_ERROR = "Employee number or PIN is incorrect.";
const SERVICE_ERROR = "Something went wrong on our side. Please try again.";

async function startSessionClock(
  userId: string,
  kind: SessionKind,
): Promise<void> {
  const cfg = loadAuthConfig().session;
  const store = await cookies();
  store.set(
    SESSION_START_COOKIE,
    createSessionStartValue(authSecret(), userId, kind, new Date()),
    {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: Math.floor(maxAgeMs(kind, cfg) / 1000),
    },
  );
}

function text(formData: FormData, key: string): string {
  const v = formData.get(key);
  return typeof v === "string" ? v : "";
}

export async function driverSignInAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const h = await headers();
  const driverAuth = await createDriverAuth();
  const result = await driverAuth.signIn({
    employeeNumber: text(formData, "employeeNumber"),
    pin: text(formData, "pin"),
    ip: clientIpFromHeaders((n) => h.get(n)),
  });
  if (!result.ok) {
    if (result.code === "locked") {
      return {
        status: "error",
        message: `Too many attempts. Try again in ${formatRetry(result.retryAfterSeconds)}.`,
      };
    }
    return {
      status: "error",
      message:
        result.code === "service_error" ? SERVICE_ERROR : GENERIC_SIGN_IN_ERROR,
    };
  }
  const ctx = await getSessionContext();
  if (!ctx) return { status: "error", message: SERVICE_ERROR };
  await startSessionClock(ctx.userId, "driver");
  redirect(result.next);
}

export async function staffSignInAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const supabase = await createSupabaseServerClient();
  const result = await staffSignIn(supabase, {
    email: text(formData, "email"),
    password: text(formData, "password"),
  });
  if (!result.ok) {
    return {
      status: "error",
      message:
        result.code === "service_error"
          ? SERVICE_ERROR
          : "Email or password is incorrect.",
    };
  }
  const ctx = await getSessionContext();
  if (!ctx) return { status: "error", message: SERVICE_ERROR };
  await startSessionClock(ctx.userId, "staff");
  redirect(result.next);
}

export async function signOutAction(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  (await cookies()).delete(SESSION_START_COOKIE);
  redirect("/sign-in");
}

export async function changePinAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const newPin = text(formData, "newPin");
  if (newPin !== text(formData, "confirmPin"))
    return { status: "error", message: "The two PINs do not match." };
  const ctx = await getSessionContext();
  if (!ctx) redirect("/sign-in");
  const driverAuth = await createDriverAuth();
  const result = await driverAuth.changePin({ newPin });
  if (!result.ok) {
    if (result.code === "weak_pin") {
      return {
        status: "error",
        message: "That PIN is not allowed.",
        details: describePinViolations(result.violations, loadAuthConfig().pin),
      };
    }
    if (result.code === "same_pin")
      return {
        status: "error",
        message: "Choose a PIN different from your current one.",
      };
    return { status: "error", message: SERVICE_ERROR };
  }
  const after = await getSessionContext();
  redirect(after ? stepFor(after) : "/sign-in");
}

export type EnrolmentState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "enrolling"; factorId: string; qrCode: string; secret: string };

export async function startMfaEnrolmentAction(): Promise<EnrolmentState> {
  const ctx = await getSessionContext();
  if (!ctx || ctx.profile.userType !== "staff")
    return { status: "error", message: "Not available." };
  const supabase = await createSupabaseServerClient();
  const started = await startTotpEnrolment(supabase);
  return started.ok
    ? {
        status: "enrolling",
        factorId: started.factorId,
        qrCode: started.qrCode,
        secret: started.secret,
      }
    : { status: "error", message: SERVICE_ERROR };
}

export async function verifyMfaAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const ctx = await getSessionContext();
  if (!ctx) redirect("/sign-in");
  const supabase = await createSupabaseServerClient();
  // Enrolment passes its own factor id; sign-in verification uses the enrolled factor.
  const factorId =
    text(formData, "factorId") || (await verifiedTotpFactorId(supabase));
  if (!factorId)
    return {
      status: "error",
      message: "No authenticator is set up for this account.",
    };
  const result = await verifyTotp(
    supabase,
    factorId,
    text(formData, "code").replace(/\s/g, ""),
  );
  if (!result.ok) {
    return {
      status: "error",
      message:
        result.code === "invalid_code"
          ? "That code is not correct. Check the code and try again."
          : SERVICE_ERROR,
    };
  }
  const after = await getSessionContext();
  redirect(after ? stepFor(after) : "/sign-in");
}
