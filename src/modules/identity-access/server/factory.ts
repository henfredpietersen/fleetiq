import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { loadAuthConfig } from "../domain/auth-config";
import type { DriverAuth } from "../domain/driver-auth";
import { SupabaseDriverAuth } from "./supabase-driver-auth";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

/** The one place the driver-auth implementation is chosen (AD-08 is Proposed; swap here if it changes). */
export async function createDriverAuth(): Promise<DriverAuth> {
  return new SupabaseDriverAuth({
    admin: createAdminClient(),
    userClient: await createSupabaseServerClient(),
    config: loadAuthConfig(),
    secret: required("AUTH_SERVER_SECRET"),
    companyId: required("FLEETIQ_COMPANY_ID"),
  });
}

export function authSecret(): string {
  return required("AUTH_SERVER_SECRET");
}
