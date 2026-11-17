import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";

/**
 * SERVICE-ROLE client — bypasses RLS. ARCH §5.3: reviewed admin functions and background jobs ONLY.
 * Allowed importers are listed in src/lib/supabase/no-service-role.test.ts (currently only the
 * reviewed sign-in / PIN modules under src/modules/identity-access/server). Never import this from a
 * client component, a route that serves ordinary user data, or anything marked "use client".
 * The key comes from a server-only env var; it must never be NEXT_PUBLIC_.
 */
export function createAdminClient(
  env: Record<string, string | undefined> = process.env,
): SupabaseClient<Database> {
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY",
    );
  }
  return createClient<Database>(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}
