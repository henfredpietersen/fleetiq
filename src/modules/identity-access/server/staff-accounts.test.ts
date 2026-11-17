import { describe, expect, it } from "vitest";
import { DEFAULT_AUTH_CONFIG } from "../domain/auth-config";
import { StaffAccounts, type StaffAccountsDeps } from "./staff-accounts";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const OTHER_COMPANY = "22222222-2222-4222-8222-222222222222";
const CALLER = "c0000000-0000-4000-8000-000000000001";
const TARGET = "c0000000-0000-4000-8000-000000000002";
const STRONG = "correct-horse-battery"; // 21 chars
const ELEVEN = "a".repeat(11);
const PIN = "482916";

type Opts = {
  caller?: string | null;
  allowed?: boolean;
  requiresMfa?: boolean;
  aal?: "aal1" | "aal2";
  callerCompany?: string | null;
  target?: { id: string; company_id: string; user_type: string } | null;
  ownUserType?: string | null;
  createError?: { code?: string } | null;
  updateError?: { code?: string } | null;
  userUpdateError?: { code?: string } | null;
  authoriseError?: { code?: string } | null;
  profileError?: { code?: string } | null; // admin_create_staff
  deleteError?: { message: string } | null; // auth.admin.deleteUser
  flagError?: { code?: string } | null; // auth_issue_staff_password_flags / auth_complete_password_change
};

/** In-memory stand-in for the two Supabase clients; `authCalls` records every Auth password write. */
function fake(o: Opts = {}) {
  const authCalls: { api: string; password: string }[] = [];
  const events: string[] = []; // order of authorisations and Auth writes
  const authorisations: { p_user: string; p_actor: string }[] = [];
  const rpcLog: { name: string; args: Record<string, unknown> }[] = [];
  const deleted: string[] = [];
  const o2 = {
    caller: CALLER as string | null,
    allowed: true,
    requiresMfa: false,
    aal: "aal2" as const,
    callerCompany: COMPANY as string | null,
    target: {
      id: TARGET,
      company_id: COMPANY,
      user_type: "staff",
    } as Opts["target"],
    ownUserType: "staff" as string | null,
    createError: null,
    updateError: null,
    userUpdateError: null,
    authoriseError: null,
    profileError: null,
    deleteError: null,
    flagError: null,
    ...o,
  };
  const admin = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcLog.push({ name, args });
      if (name === "authorise_staff_password_change") {
        events.push("authorise");
        authorisations.push(args as { p_user: string; p_actor: string });
        return { error: o2.authoriseError };
      }
      if (name === "admin_create_staff") {
        events.push("profile");
        return { error: o2.profileError };
      }
      if (
        name === "auth_issue_staff_password_flags" ||
        name === "auth_complete_password_change"
      ) {
        events.push(
          name === "auth_complete_password_change" ? "clear_flag" : "set_flag",
        );
        return { error: o2.flagError };
      }
      throw new Error(`unexpected admin rpc ${name}`);
    },
    auth: {
      admin: {
        createUser: async (a: { password: string }) => {
          events.push("createUser");
          authCalls.push({ api: "createUser", password: a.password });
          return o2.createError
            ? { data: { user: null }, error: o2.createError }
            : { data: { user: { id: "new-user" } }, error: null };
        },
        deleteUser: async (id: string) => {
          events.push("deleteUser");
          deleted.push(id);
          return { error: o2.deleteError };
        },
        updateUserById: async (_id: string, a: { password: string }) => {
          events.push("updateUserById");
          authCalls.push({ api: "updateUserById", password: a.password });
          return { error: o2.updateError };
        },
      },
    },
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: o2.target }) }),
      }),
    }),
  };
  const userClient = {
    auth: {
      getUser: async () => ({
        data: { user: o2.caller ? { id: o2.caller } : null },
      }),
      getClaims: async () => ({ data: { claims: { aal: o2.aal } } }),
      updateUser: async (a: { password: string }) => {
        events.push("updateUser");
        authCalls.push({ api: "updateUser", password: a.password });
        return { error: o2.userUpdateError };
      },
    },
    rpc: async (name: string) => {
      if (name === "current_user_requires_mfa")
        return { data: o2.requiresMfa, error: null };
      if (name === "has_permission") return { data: o2.allowed, error: null };
      if (name === "current_company_id")
        return { data: o2.callerCompany, error: null };
      throw new Error(`unexpected rpc ${name}`);
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: o2.ownUserType ? { user_type: o2.ownUserType } : null,
          }),
        }),
      }),
    }),
  };
  const svc = new StaffAccounts({
    admin,
    userClient,
    config: DEFAULT_AUTH_CONFIG,
  } as unknown as StaffAccountsDeps);
  return { svc, authCalls, events, authorisations, rpcLog, deleted };
}

describe("default policy", () => {
  it("is 12 characters", () => {
    expect(DEFAULT_AUTH_CONFIG.staffPassword.minLength).toBe(12);
  });
});

describe("CREATE staff user", () => {
  it("rejects 11 characters and a PIN-length password without calling Auth", async () => {
    for (const weak of [ELEVEN, PIN, ""]) {
      const { svc, authCalls } = fake();
      const r = await svc.createStaffUser({
        email: "a@example.test",
        displayName: "Synthetic Staff",
        password: weak,
      });
      expect(r).toEqual({
        ok: false,
        code: "weak_password",
        violations: ["too_short"],
      });
      expect(authCalls).toEqual([]);
    }
  });

  it("creates the user when the password meets the policy", async () => {
    const { svc, authCalls } = fake();
    const r = await svc.createStaffUser({
      email: " A@Example.test ",
      displayName: "Synthetic Staff",
      password: STRONG,
    });
    expect(r).toEqual({ ok: true, userId: "new-user" });
    expect(authCalls).toEqual([{ api: "createUser", password: STRONG }]);
  });

  it("accepts exactly 12 characters", async () => {
    const { svc } = fake();
    const r = await svc.createStaffUser({
      email: "a@example.test",
      displayName: "Synthetic Staff",
      password: "a".repeat(12),
    });
    expect(r.ok).toBe(true);
  });

  it("refuses a driver's internal login identifier as the email", async () => {
    const { svc, authCalls } = fake();
    const r = await svc.createStaffUser({
      email: "e1001@drivers.fleetiq.invalid",
      displayName: "Synthetic Staff",
      password: STRONG,
    });
    expect(r).toEqual({ ok: false, code: "invalid_email" });
    expect(authCalls).toEqual([]);
  });

  it("is denied without users.roles.manage, without a session, and without MFA", async () => {
    for (const [opts, code] of [
      [{ allowed: false }, "forbidden"],
      [{ caller: null }, "unauthenticated"],
      [{ requiresMfa: true, aal: "aal1" as const }, "mfa_required"],
    ] as const) {
      const { svc, authCalls } = fake(opts);
      const r = await svc.createStaffUser({
        email: "a@example.test",
        displayName: "Synthetic Staff",
        password: STRONG,
      });
      expect(r).toEqual({ ok: false, code });
      expect(authCalls).toEqual([]);
    }
  });

  it("maps duplicate email and Auth failures", async () => {
    expect(
      await fake({ createError: { code: "email_exists" } }).svc.createStaffUser(
        {
          email: "a@example.test",
          displayName: "Synthetic Staff",
          password: STRONG,
        },
      ),
    ).toEqual({ ok: false, code: "email_taken" });
    expect(
      await fake({ createError: { code: "unexpected" } }).svc.createStaffUser({
        email: "a@example.test",
        displayName: "Synthetic Staff",
        password: STRONG,
      }),
    ).toEqual({ ok: false, code: "service_error" });
  });
});

describe("RESET staff password", () => {
  it("rejects a weak password before any lookup or Auth call", async () => {
    for (const weak of [ELEVEN, PIN]) {
      const { svc, authCalls } = fake();
      const r = await svc.resetStaffPassword({
        targetUserId: TARGET,
        newPassword: weak,
      });
      expect(r).toEqual({
        ok: false,
        code: "weak_password",
        violations: ["too_short"],
      });
      expect(authCalls).toEqual([]);
    }
  });

  it("resets a staff member in the same company", async () => {
    const { svc, authCalls } = fake();
    expect(
      await svc.resetStaffPassword({
        targetUserId: TARGET,
        newPassword: STRONG,
      }),
    ).toEqual({ ok: true });
    expect(authCalls).toEqual([{ api: "updateUserById", password: STRONG }]);
  });

  it("refuses to reset your own password (DEC-24)", async () => {
    const { svc, authCalls } = fake();
    expect(
      await svc.resetStaffPassword({
        targetUserId: CALLER,
        newPassword: STRONG,
      }),
    ).toEqual({
      ok: false,
      code: "self_reset",
    });
    expect(authCalls).toEqual([]);
  });

  it("is denied without permission or MFA", async () => {
    for (const [opts, code] of [
      [{ allowed: false }, "forbidden"],
      [{ requiresMfa: true, aal: "aal1" as const }, "mfa_required"],
      [{ caller: null }, "unauthenticated"],
    ] as const) {
      const { svc, authCalls } = fake(opts);
      expect(
        await svc.resetStaffPassword({
          targetUserId: TARGET,
          newPassword: STRONG,
        }),
      ).toEqual({ ok: false, code });
      expect(authCalls).toEqual([]);
    }
  });

  it("does not reveal or touch a target in another company, a driver, or a missing profile", async () => {
    for (const target of [
      { id: TARGET, company_id: OTHER_COMPANY, user_type: "staff" },
      { id: TARGET, company_id: COMPANY, user_type: "driver" },
      null,
    ]) {
      const { svc, authCalls } = fake({ target });
      expect(
        await svc.resetStaffPassword({
          targetUserId: TARGET,
          newPassword: STRONG,
        }),
      ).toEqual({
        ok: false,
        code: "not_found",
      });
      expect(authCalls).toEqual([]);
    }
  });

  it("reports an Auth failure as a service error", async () => {
    const { svc } = fake({ updateError: { code: "boom" } });
    expect(
      await svc.resetStaffPassword({
        targetUserId: TARGET,
        newPassword: STRONG,
      }),
    ).toEqual({
      ok: false,
      code: "service_error",
    });
  });
});

describe("CHANGE own staff password", () => {
  it("rejects a weak password without calling Auth", async () => {
    for (const weak of [ELEVEN, PIN]) {
      const { svc, authCalls } = fake();
      expect(await svc.changeOwnPassword({ newPassword: weak })).toEqual({
        ok: false,
        code: "weak_password",
        violations: ["too_short"],
      });
      expect(authCalls).toEqual([]);
    }
  });

  it("changes the password when it meets the policy", async () => {
    const { svc, authCalls } = fake();
    expect(await svc.changeOwnPassword({ newPassword: STRONG })).toEqual({
      ok: true,
    });
    expect(authCalls).toEqual([{ api: "updateUser", password: STRONG }]);
  });

  it("is refused for a driver (drivers change a PIN) and without a session", async () => {
    const driver = fake({ ownUserType: "driver" });
    expect(await driver.svc.changeOwnPassword({ newPassword: STRONG })).toEqual(
      { ok: false, code: "forbidden" },
    );
    expect(driver.authCalls).toEqual([]);
    const anon = fake({ caller: null });
    expect(await anon.svc.changeOwnPassword({ newPassword: STRONG })).toEqual({
      ok: false,
      code: "unauthenticated",
    });
    expect(anon.authCalls).toEqual([]);
  });

  it("maps Auth's same-password and weak-password errors", async () => {
    expect(
      await fake({
        userUpdateError: { code: "same_password" },
      }).svc.changeOwnPassword({ newPassword: STRONG }),
    ).toEqual({ ok: false, code: "same_password" });
    expect(
      await fake({
        userUpdateError: { code: "weak_password" },
      }).svc.changeOwnPassword({ newPassword: STRONG }),
    ).toEqual({ ok: false, code: "weak_password", violations: ["too_short"] });
  });
});

describe("database authorisation for staff password changes (migration 017)", () => {
  it("RESET records one authorisation for the target, before the Auth write", async () => {
    const { svc, events, authorisations } = fake();
    await svc.resetStaffPassword({ targetUserId: TARGET, newPassword: STRONG });
    expect(events).toEqual(["authorise", "set_flag", "updateUserById"]);
    expect(authorisations).toEqual([{ p_user: TARGET, p_actor: CALLER }]);
  });

  it("CHANGE records one authorisation for the caller, before the Auth write", async () => {
    const { svc, events, authorisations } = fake();
    await svc.changeOwnPassword({ newPassword: STRONG });
    expect(events).toEqual(["authorise", "updateUser", "clear_flag"]);
    expect(authorisations).toEqual([{ p_user: CALLER, p_actor: CALLER }]);
  });

  it("no authorisation is recorded for a weak password, a forbidden caller or a bad target", async () => {
    const cases = [
      fake(),
      fake({ allowed: false }),
      fake({
        target: { id: TARGET, company_id: OTHER_COMPANY, user_type: "staff" },
      }),
      fake({
        target: { id: TARGET, company_id: COMPANY, user_type: "driver" },
      }),
    ];
    await cases[0].svc.resetStaffPassword({
      targetUserId: TARGET,
      newPassword: PIN,
    });
    for (const c of cases.slice(1))
      await c.svc.resetStaffPassword({
        targetUserId: TARGET,
        newPassword: STRONG,
      });
    const driver = fake({ ownUserType: "driver" });
    await driver.svc.changeOwnPassword({ newPassword: STRONG });
    const weakChange = fake();
    await weakChange.svc.changeOwnPassword({ newPassword: ELEVEN });
    for (const c of [...cases, driver, weakChange])
      expect(c.authorisations).toEqual([]);
  });

  it("if the authorisation cannot be recorded, nothing is written to Auth", async () => {
    const reset = fake({ authoriseError: { code: "42501" } });
    expect(
      await reset.svc.resetStaffPassword({
        targetUserId: TARGET,
        newPassword: STRONG,
      }),
    ).toEqual({
      ok: false,
      code: "service_error",
    });
    expect(reset.authCalls).toEqual([]);
    const change = fake({ authoriseError: { code: "42501" } });
    expect(await change.svc.changeOwnPassword({ newPassword: STRONG })).toEqual(
      { ok: false, code: "service_error" },
    );
    expect(change.authCalls).toEqual([]);
  });

  it("CREATE needs no authorisation (inserting a user is not a password update)", async () => {
    const { svc, authorisations } = fake();
    await svc.createStaffUser({
      email: "a@example.test",
      displayName: "Synthetic Staff",
      password: STRONG,
    });
    expect(authorisations).toEqual([]);
  });
});

describe("staff account creation is one flow with no orphan Auth user", () => {
  it("creates the Auth user, then the profile (attributed to the caller), and returns a generated temporary password once", async () => {
    const { svc, events, rpcLog, authCalls } = fake();
    const r = await svc.createStaffUser({
      email: "New@Example.test",
      displayName: " Synthetic New ",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.temporaryPassword).toBeDefined();
    expect([...(r.temporaryPassword ?? "")].length).toBeGreaterThanOrEqual(12);
    expect(authCalls).toEqual([
      { api: "createUser", password: r.temporaryPassword },
    ]);
    expect(events).toEqual(["createUser", "profile"]);
    expect(rpcLog).toEqual([
      {
        name: "admin_create_staff",
        args: {
          p_actor: CALLER,
          p_user_id: "new-user",
          p_email: "new@example.test",
          p_display_name: "Synthetic New",
        },
      },
    ]);
  });

  it("does not return a password when the caller supplied one", async () => {
    const r = await fake().svc.createStaffUser({
      email: "a@example.test",
      displayName: "S",
      password: STRONG,
    });
    expect(r).toEqual({ ok: true, userId: "new-user" });
  });

  it("deletes the Auth user when the profile step fails (no orphan) and reports the failure", async () => {
    const { svc, events, deleted } = fake({ profileError: { code: "XX000" } });
    const r = await svc.createStaffUser({
      email: "a@example.test",
      displayName: "S",
    });
    expect(r).toEqual({ ok: false, code: "service_error" });
    expect(events).toEqual(["createUser", "profile", "deleteUser"]);
    expect(deleted).toEqual(["new-user"]);
  });

  it("maps a database refusal after rollback, and a duplicate email", async () => {
    expect(
      await fake({ profileError: { code: "42501" } }).svc.createStaffUser({
        email: "a@example.test",
        displayName: "S",
      }),
    ).toEqual({ ok: false, code: "forbidden" });
    expect(
      await fake({ profileError: { code: "23505" } }).svc.createStaffUser({
        email: "a@example.test",
        displayName: "S",
      }),
    ).toEqual({ ok: false, code: "email_taken" });
  });

  it("says so loudly when the rollback itself fails, naming the orphan", async () => {
    const { svc } = fake({
      profileError: { code: "XX000" },
      deleteError: { message: "down" },
    });
    expect(
      await svc.createStaffUser({ email: "a@example.test", displayName: "S" }),
    ).toEqual({
      ok: false,
      code: "rollback_failed",
      orphanUserId: "new-user",
    });
  });

  it("never creates an Auth user for a weak supplied password, a bad email or an unauthorised caller", async () => {
    for (const [input, opts] of [
      [{ email: "a@example.test", displayName: "S", password: ELEVEN }, {}],
      [{ email: "not-an-email", displayName: "S" }, {}],
      [{ email: "a@example.test", displayName: " " }, {}],
      [{ email: "a@example.test", displayName: "S" }, { allowed: false }],
    ] as const) {
      const { svc, events } = fake(opts);
      const r = await svc.createStaffUser(input);
      expect(r.ok).toBe(false);
      expect(events).toEqual([]);
    }
  });
});

describe("forced change flags", () => {
  it("RESET marks the password as temporary before changing it", async () => {
    const { svc, rpcLog } = fake();
    await svc.resetStaffPassword({ targetUserId: TARGET, newPassword: STRONG });
    expect(rpcLog.map((c) => c.name)).toEqual([
      "authorise_staff_password_change",
      "auth_issue_staff_password_flags",
    ]);
    expect(rpcLog[1].args).toEqual({ p_target: TARGET, p_actor: CALLER });
  });

  it("if the flag cannot be set, the password is not changed", async () => {
    const { svc, authCalls } = fake({ flagError: { code: "42501" } });
    expect(
      await svc.resetStaffPassword({
        targetUserId: TARGET,
        newPassword: STRONG,
      }),
    ).toEqual({ ok: false, code: "service_error" });
    expect(authCalls).toEqual([]);
  });

  it("CHANGE clears the forced-change flag only after Auth accepted the password", async () => {
    const ok = fake();
    await ok.svc.changeOwnPassword({ newPassword: STRONG });
    expect(ok.events.at(-1)).toBe("clear_flag");
    const rejected = fake({ userUpdateError: { code: "same_password" } });
    await rejected.svc.changeOwnPassword({ newPassword: STRONG });
    expect(rejected.events).not.toContain("clear_flag");
  });
});

describe("configurable minimum", () => {
  it("a raised minimum applies to every path", async () => {
    const mk = () =>
      new StaffAccounts({
        ...({
          admin: fake().svc as never,
        } as object),
        config: { staffPassword: { minLength: 16 } },
      } as unknown as StaffAccountsDeps);
    // Policy runs before any client is touched, so unusable clients prove nothing reached Auth.
    const svc = mk();
    const weak = "a".repeat(15);
    expect(
      await svc.createStaffUser({
        email: "a@example.test",
        displayName: "Synthetic Staff",
        password: weak,
      }),
    ).toMatchObject({ code: "weak_password" });
    expect(
      await svc.resetStaffPassword({ targetUserId: TARGET, newPassword: weak }),
    ).toMatchObject({ code: "weak_password" });
    expect(await svc.changeOwnPassword({ newPassword: weak })).toMatchObject({
      code: "weak_password",
    });
  });
});
