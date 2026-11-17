import { describe, expect, it } from "vitest";
import { DEFAULT_AUTH_CONFIG } from "../domain/auth-config";
import type { DriverSignInResult } from "../domain/driver-auth";
import {
  deriveLoginIdentifier,
  hashEmployeeNumber,
  normalizeEmployeeNumber,
} from "../domain/identifiers";
import {
  SupabaseDriverAuth,
  type DriverAuthDeps,
} from "./supabase-driver-auth";

const secret = "t".repeat(40);
const company = "11111111-1111-4111-8111-111111111111";
const PROFILE = {
  id: "p-1",
  company_id: company,
  user_type: "driver",
  status: "active",
};
const GOOD_PIN = "482916";

/** In-memory stand-in for Supabase: same counting rules as public.auth_login_counts. */
function fake(opts: { profile?: typeof PROFILE | null; clock: { t: number } }) {
  const known = deriveLoginIdentifier(secret, company, "E1001");
  const attempts: { emp: string; ip: string; ok: boolean; at: number }[] = [];
  const log: string[] = [];
  const locked: string[] = [];
  let signedIn = false;
  const nowMs = () => opts.clock.t;
  const admin = {
    from: () => ({
      select: () => ({
        eq: (_c: string, id: string) => ({
          maybeSingle: async () => ({
            data:
              id === known && opts.profile !== null
                ? (opts.profile ?? PROFILE)
                : null,
          }),
        }),
      }),
    }),
    rpc: (name: string, args: Record<string, unknown>) => {
      log.push(name);
      if (name === "auth_login_counts") {
        const win = DEFAULT_AUTH_CONFIG.lockout.windowMinutes * 60_000;
        const emp = attempts.filter((a) => a.emp === args.p_emp_hash);
        const floor = Math.max(
          nowMs() - win,
          ...emp.filter((a) => a.ok).map((a) => a.at),
          -Infinity,
        );
        const f = emp.filter((a) => !a.ok && a.at > floor);
        const ipf = attempts.filter(
          (a) => a.ip === args.p_ip_hash && !a.ok && a.at > nowMs() - win,
        );
        const iso = (xs: { at: number }[]) =>
          xs.length
            ? new Date(Math.max(...xs.map((x) => x.at))).toISOString()
            : null;
        return {
          single: async () => ({
            data: {
              account_failures: f.length,
              account_last_failure: iso(f),
              ip_failures: ipf.length,
              ip_last_failure: iso(ipf),
            },
            error: null,
          }),
        };
      }
      if (name === "auth_login_record")
        attempts.push({
          emp: args.p_emp_hash as string,
          ip: args.p_ip_hash as string,
          ok: args.p_succeeded as boolean,
          at: nowMs(),
        });
      if (name === "auth_lock_profile") locked.push(args.p_profile as string);
      return Promise.resolve({ data: null, error: null });
    },
  };
  const userClient = {
    auth: {
      signInWithPassword: async (c: { email: string; password: string }) => {
        log.push("signIn");
        if (c.email === known && c.password === GOOD_PIN) {
          signedIn = true;
          return { data: { user: { id: "p-1" } }, error: null };
        }
        return {
          data: { user: null },
          error: { message: "Invalid login credentials" },
        };
      },
      signOut: async () => void (signedIn = false),
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: { must_change_pin: false } }),
        }),
      }),
    }),
  };
  const deps = {
    admin,
    userClient,
    config: DEFAULT_AUTH_CONFIG,
    secret,
    companyId: company,
    now: () => new Date(nowMs()),
  } as unknown as DriverAuthDeps;
  return {
    auth: new SupabaseDriverAuth(deps),
    attempts,
    log,
    locked,
    isSignedIn: () => signedIn,
  };
}

const ip = "198.51.100.7";
const t0 = Date.parse("2026-11-17T10:00:00Z");

async function wrongPins(
  f: ReturnType<typeof fake>,
  emp: string,
  n: number,
  clock: { t: number },
) {
  const out: DriverSignInResult[] = [];
  for (let i = 0; i < n; i++) {
    out.push(await f.auth.signIn({ employeeNumber: emp, pin: "999111", ip }));
    clock.t += 1000;
  }
  return out;
}

describe("DriverAuth.signIn — non-disclosure", () => {
  it("unknown number and wrong PIN give identical results, step for step, including lockout", async () => {
    const c1 = { t: t0 };
    const c2 = { t: t0 };
    const known = await wrongPins(fake({ clock: c1 }), "E1001", 7, c1);
    const unknown = await wrongPins(fake({ clock: c2 }), "E9999", 7, c2);
    expect(unknown).toEqual(known);
    expect(
      known
        .slice(0, 4)
        .every((r) => r.ok === false && r.code === "invalid_credentials"),
    ).toBe(true);
    expect(known[4]).toMatchObject({ ok: false, code: "locked" });
    expect(known[6]).toMatchObject({ ok: false, code: "locked" });
  });

  it("malformed numbers are processed like any other (no early exit that would distinguish them)", async () => {
    const c = { t: t0 };
    const f = fake({ clock: c });
    const r = await f.auth.signIn({
      employeeNumber: "not a number!",
      pin: "123456",
      ip,
    });
    expect(r).toEqual({ ok: false, code: "invalid_credentials" });
    expect(f.log).toEqual(["auth_login_counts", "signIn", "auth_login_record"]);
    expect(f.attempts[0]!.emp).toMatch(/^[0-9a-f]{64}$/);
  });

  it("known-wrong and unknown take the same Auth/DB path", async () => {
    const ca = { t: t0 };
    const a = fake({ clock: ca });
    const b = fake({ clock: { t: t0 } });
    await a.auth.signIn({ employeeNumber: "E1001", pin: "999111", ip });
    await b.auth.signIn({ employeeNumber: "E9999", pin: "999111", ip });
    expect(a.log).toEqual(b.log);
  });

  it("stores only hashes, never the employee number or IP", async () => {
    const f = fake({ clock: { t: t0 } });
    await f.auth.signIn({ employeeNumber: "E1001", pin: "999111", ip });
    const row = f.attempts[0]!;
    expect(row.emp).toBe(
      hashEmployeeNumber(secret, company, normalizeEmployeeNumber("E1001")!),
    );
    expect(JSON.stringify(f.attempts)).not.toContain("E1001");
    expect(JSON.stringify(f.attempts)).not.toContain(ip);
  });

  it("a disabled or non-driver profile fails exactly like a wrong PIN and signs out", async () => {
    for (const bad of [
      { ...PROFILE, status: "disabled" },
      { ...PROFILE, user_type: "staff" },
    ]) {
      const f = fake({ clock: { t: t0 }, profile: bad });
      const r = await f.auth.signIn({
        employeeNumber: "E1001",
        pin: GOOD_PIN,
        ip,
      });
      expect(r).toEqual({ ok: false, code: "invalid_credentials" });
      expect(f.isSignedIn()).toBe(false);
    }
  });
});

describe("DriverAuth.signIn — lockout behaviour", () => {
  it("locks the profile (audited via DB function) when the threshold is reached, and skips Auth while locked", async () => {
    const c = { t: t0 };
    const f = fake({ clock: c });
    await wrongPins(f, "E1001", 5, c);
    expect(f.locked).toEqual(["p-1"]);
    f.log.length = 0;
    const r = await f.auth.signIn({
      employeeNumber: "E1001",
      pin: GOOD_PIN,
      ip,
    });
    expect(r).toMatchObject({ ok: false, code: "locked" });
    expect(f.log).not.toContain("signIn"); // even the right PIN is not tried while locked
  });

  it("allows sign-in again once the lockout has elapsed, and success resets the count", async () => {
    const c = { t: t0 };
    const f = fake({ clock: c });
    await wrongPins(f, "E1001", 5, c);
    c.t += 16 * 60_000;
    expect(
      await f.auth.signIn({ employeeNumber: "E1001", pin: GOOD_PIN, ip }),
    ).toEqual({ ok: true, next: "/home" });
    expect(f.attempts.at(-1)!.ok).toBe(true);
  });

  it("per-IP limit blocks a noisy IP across different numbers", async () => {
    const c = { t: t0 };
    const f = fake({ clock: c });
    for (let i = 0; i < 20; i++)
      await f.auth.signIn({
        employeeNumber: `E${2000 + i}`,
        pin: "999111",
        ip,
      });
    const r = await f.auth.signIn({
      employeeNumber: "E1001",
      pin: GOOD_PIN,
      ip,
    });
    expect(r).toMatchObject({ ok: false, code: "locked" });
    expect(
      await f.auth.signIn({
        employeeNumber: "E1001",
        pin: GOOD_PIN,
        ip: "203.0.113.1",
      }),
    ).toMatchObject({ ok: true });
  });

  it("reports a service error rather than guessing when counting fails", async () => {
    const f = fake({ clock: { t: t0 } });
    const deps = (f.auth as unknown as { d: { admin: { rpc: unknown } } }).d;
    deps.admin.rpc = () => ({
      single: async () => ({ data: null, error: { message: "down" } }),
    });
    expect(
      await f.auth.signIn({ employeeNumber: "E1001", pin: GOOD_PIN, ip }),
    ).toEqual({ ok: false, code: "service_error" });
  });
});

describe("DriverAuth.issuePin — DEC-24", () => {
  it("refuses to issue or reset your own PIN before touching anything else", async () => {
    const calls: string[] = [];
    const deps = {
      admin: {
        rpc: (n: string) => (calls.push(n), Promise.resolve({ error: null })),
        from: () => (calls.push("from"), {}),
      },
      userClient: {
        auth: { getUser: async () => ({ data: { user: { id: "me" } } }) },
      },
      config: DEFAULT_AUTH_CONFIG,
      secret,
      companyId: company,
    } as unknown as DriverAuthDeps;
    const r = await new SupabaseDriverAuth(deps).issuePin({
      targetProfileId: "me",
      mode: "reset",
    });
    expect(r).toEqual({ ok: false, code: "self_reset" });
    expect(calls).toEqual([]);
  });

  it("requires a signed-in caller", async () => {
    const deps = {
      admin: {},
      userClient: { auth: { getUser: async () => ({ data: { user: null } }) } },
      config: DEFAULT_AUTH_CONFIG,
      secret,
      companyId: company,
    } as unknown as DriverAuthDeps;
    expect(
      await new SupabaseDriverAuth(deps).issuePin({
        targetProfileId: "x",
        mode: "issue",
      }),
    ).toEqual({ ok: false, code: "unauthenticated" });
  });
});
