import { describe, expect, it } from "vitest";
import { DEFAULT_AUTH_CONFIG } from "../domain/auth-config";
import {
  deriveLoginIdentifier,
  isInternalIdentifier,
} from "../domain/identifiers";
import { validatePin } from "../domain/pin-rules";
import { DriverAccounts, type DriverAccountsDeps } from "./driver-accounts";

const SECRET = "t".repeat(40);
const COMPANY = "11111111-1111-4111-8111-111111111111";
const BRANCH = "22222222-2222-4222-8222-222222222222";
const CALLER = "c0000000-0000-4000-8000-000000000001";
const INPUT = {
  branchId: BRANCH,
  employeeNumber: " t0001 ",
  displayName: " Synthetic Driver ",
};

type Opts = {
  caller?: string | null;
  allowed?: boolean;
  requiresMfa?: boolean;
  aal?: "aal1" | "aal2";
  createError?: { code?: string } | null;
  dbError?: { code?: string } | null;
  deleteError?: { message: string } | null;
};

function fake(o: Opts = {}) {
  const events: string[] = [];
  const created: { email: string; password: string }[] = [];
  const rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
  const deleted: string[] = [];
  const cfg = {
    caller: CALLER as string | null,
    allowed: true,
    requiresMfa: false,
    aal: "aal2",
    createError: null,
    dbError: null,
    deleteError: null,
    ...o,
  };
  const admin = {
    auth: {
      admin: {
        createUser: async (a: { email: string; password: string }) => {
          events.push("createUser");
          created.push(a);
          return cfg.createError
            ? { data: { user: null }, error: cfg.createError }
            : { data: { user: { id: "new-auth-user" } }, error: null };
        },
        deleteUser: async (id: string) => {
          events.push("deleteUser");
          deleted.push(id);
          return { error: cfg.deleteError };
        },
      },
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      events.push(name);
      rpcCalls.push({ name, args });
      return cfg.dbError
        ? { data: null, error: cfg.dbError }
        : { data: "new-driver-id", error: null };
    },
  };
  const userClient = {
    auth: {
      getUser: async () => ({
        data: { user: cfg.caller ? { id: cfg.caller } : null },
      }),
      getClaims: async () => ({ data: { claims: { aal: cfg.aal } } }),
    },
    rpc: async (name: string) => {
      if (name === "current_user_requires_mfa")
        return { data: cfg.requiresMfa, error: null };
      if (name === "has_permission") {
        events.push("has_permission");
        return { data: cfg.allowed, error: null };
      }
      if (name === "current_company_id") return { data: COMPANY, error: null };
      throw new Error(`unexpected rpc ${name}`);
    },
  };
  const svc = new DriverAccounts({
    admin,
    userClient,
    config: DEFAULT_AUTH_CONFIG,
    secret: SECRET,
  } as unknown as DriverAccountsDeps);
  return { svc, events, created, rpcCalls, deleted };
}

describe("createDriver — success", () => {
  it("creates the Auth user with the internal login identifier and a rule-abiding temporary PIN, then the database rows", async () => {
    const { svc, events, created, rpcCalls } = fake();
    const r = await svc.createDriver(INPUT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const loginId = deriveLoginIdentifier(SECRET, COMPANY, "T0001");
    expect(created).toEqual([
      { email: loginId, password: r.pin, email_confirm: true },
    ]);
    expect(isInternalIdentifier(created[0].email)).toBe(true); // AD-08: no real email
    expect(validatePin(r.pin, DEFAULT_AUTH_CONFIG.pin).ok).toBe(true);
    expect(events).toEqual([
      "has_permission",
      "createUser",
      "admin_create_driver",
    ]);
    expect(rpcCalls[0].args).toEqual({
      p_actor: CALLER,
      p_user_id: "new-auth-user",
      p_branch_id: BRANCH,
      p_employee_number: "T0001",
      p_login_identifier: loginId,
      p_display_name: "Synthetic Driver",
      p_phone: undefined,
    });
    expect(r.driverId).toBe("new-driver-id");
    expect(r.userId).toBe("new-auth-user");
  });

  it("never issues a PIN the rules reject (123456, 111111, 000000 and similar)", async () => {
    for (const bad of ["123456", "111111", "000000", "654321", "121212"]) {
      expect(validatePin(bad, DEFAULT_AUTH_CONFIG.pin).ok, bad).toBe(false);
    }
    for (let i = 0; i < 200; i++) {
      const r = await fake().svc.createDriver(INPUT);
      if (r.ok)
        expect(validatePin(r.pin, DEFAULT_AUTH_CONFIG.pin).ok).toBe(true);
    }
  });
});

describe("createDriver — refused before anything is created", () => {
  it("without driver.manage in that branch (e.g. a supervisor)", async () => {
    const { svc, events } = fake({ allowed: false });
    expect(await svc.createDriver(INPUT)).toEqual({
      ok: false,
      code: "forbidden",
    });
    expect(events).toEqual(["has_permission"]); // no Auth user, no database write
  });

  it("without a session, and without MFA when the caller's roles require it", async () => {
    const a = fake({ caller: null });
    expect(await a.svc.createDriver(INPUT)).toEqual({
      ok: false,
      code: "unauthenticated",
    });
    expect(a.events).toEqual([]);
    const b = fake({ requiresMfa: true, aal: "aal1" });
    expect(await b.svc.createDriver(INPUT)).toEqual({
      ok: false,
      code: "mfa_required",
    });
    expect(b.events).toEqual([]);
  });

  it("for an invalid employee number or an empty name", async () => {
    for (const input of [
      { ...INPUT, employeeNumber: "no spaces allowed" },
      { ...INPUT, employeeNumber: "" },
      { ...INPUT, displayName: "   " },
    ]) {
      const { svc, events } = fake();
      const r = await svc.createDriver(input);
      expect(r.ok).toBe(false);
      expect(events).toEqual([]);
    }
  });

  it("a duplicate employee number stops at Auth: no database call, no orphan", async () => {
    const { svc, events } = fake({ createError: { code: "email_exists" } });
    expect(await svc.createDriver(INPUT)).toEqual({
      ok: false,
      code: "employee_number_taken",
    });
    expect(events).toEqual(["has_permission", "createUser"]);
  });
});

describe("createDriver — no orphan Auth user when a later step fails", () => {
  it("deletes the Auth user when the database step fails, and never returns a PIN", async () => {
    const { svc, events, deleted } = fake({ dbError: { code: "XX000" } });
    const r = await svc.createDriver(INPUT);
    expect(r).toEqual({ ok: false, code: "service_error" });
    expect(JSON.stringify(r)).not.toMatch(/\d{6}/);
    expect(events).toEqual([
      "has_permission",
      "createUser",
      "admin_create_driver",
      "deleteUser",
    ]);
    expect(deleted).toEqual(["new-auth-user"]);
  });

  it("maps a database refusal after cleaning up", async () => {
    for (const [code, expected] of [
      ["42501", "forbidden"],
      ["23505", "employee_number_taken"],
      ["23514", "invalid_input"],
    ] as const) {
      const { svc, deleted } = fake({ dbError: { code } });
      expect(await svc.createDriver(INPUT)).toEqual({
        ok: false,
        code: expected,
      });
      expect(deleted).toEqual(["new-auth-user"]);
    }
  });

  it("reports the orphan loudly if the cleanup itself fails", async () => {
    const { svc } = fake({
      dbError: { code: "XX000" },
      deleteError: { message: "down" },
    });
    expect(await svc.createDriver(INPUT)).toEqual({
      ok: false,
      code: "rollback_failed",
      orphanUserId: "new-auth-user",
    });
  });
});
