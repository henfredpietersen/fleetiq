// Public Supabase settings only. The service-role key is deliberately NOT read here:
// it belongs to server-only job/admin modules (CLAUDE.md rule), never to user requests.
export type SupabaseEnv = { url: string; anonKey: string };

export function getSupabaseEnv(
  env: Record<string, string | undefined> = process.env,
): SupabaseEnv {
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY",
    );
  }
  return { url, anonKey };
}
