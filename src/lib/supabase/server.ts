import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { connection } from "next/server";
import type { Database } from "@/lib/database.types";
import { getSupabaseEnv } from "./env";

/**
 * Supabase client bound to the signed-in user's session (anon key + auth cookies).
 * Every query therefore runs under RLS as that user. Never use the service-role key here.
 */
export async function createSupabaseServerClient() {
  // A session is request data: never create the auth client during a prerender. The client's initial session read calls
  // Date.now() before any request data is touched, which Next.js reports as "blocking-prerender-current-time" (it then
  // filled the e2e log). Waiting for the request first keeps every caller dynamic and the warning gone.
  await connection();
  const { url, anonKey } = getSupabaseEnv();
  const cookieStore = await cookies();
  return createServerClient<Database>(url, anonKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (list) => {
        try {
          for (const { name, value, options } of list) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a Server Component: cookies are read-only there.
          // Session refresh is handled where cookies are writable (auth slice).
        }
      },
    },
  });
}
