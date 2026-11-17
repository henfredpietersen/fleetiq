import { describe, expect, it } from "vitest";
import { getSupabaseEnv } from "./env";

describe("getSupabaseEnv", () => {
  it("returns the public url and anon key", () => {
    expect(
      getSupabaseEnv({
        NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
        NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
      }),
    ).toEqual({ url: "http://127.0.0.1:54321", anonKey: "anon" });
  });

  it.each([
    {},
    { NEXT_PUBLIC_SUPABASE_URL: "http://x" },
    { NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon" },
    { NEXT_PUBLIC_SUPABASE_URL: "", NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon" },
  ])("throws when configuration is missing: %j", (env) => {
    expect(() => getSupabaseEnv(env)).toThrow(/Missing NEXT_PUBLIC_SUPABASE/);
  });

  it("ignores a service-role key even if present", () => {
    const result = getSupabaseEnv({
      NEXT_PUBLIC_SUPABASE_URL: "http://x",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
      SUPABASE_SERVICE_ROLE_KEY: "secret",
    });
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});
