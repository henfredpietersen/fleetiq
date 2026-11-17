import { beforeAll, describe, expect, it } from "vitest";
import {
  admin,
  anonClient,
  grant,
  makeBootstrap,
  makeDriver,
  makeStaff,
  makeWorld,
  signInStaff,
  type Db,
  type World,
} from "./helpers";
import { driverAuthFor } from "./driver-auth";

let w: World;
let boot: Awaited<ReturnType<typeof makeBootstrap>>;

beforeAll(async () => {
  w = await makeWorld();
  boot = await makeBootstrap(w);
});

describe("driver lockout (AD-08)", () => {
  it("locks after repeated wrong PINs, refuses even the right PIN, audits the lockout, and recovers after an admin reset", async () => {
    const d = await makeDriver(w, "L1001", "482916");
    await grant(w, d.id, "driver", w.branchId, boot.id);
    const auth = driverAuthFor(w);
    for (let i = 0; i < 4; i++) {
      expect(
        await auth.signIn({
          employeeNumber: "L1001",
          pin: "999111",
          ip: "198.51.100.10",
        }),
      ).toEqual({ ok: false, code: "invalid_credentials" });
    }
    expect(
      await auth.signIn({
        employeeNumber: "L1001",
        pin: "999111",
        ip: "198.51.100.10",
      }),
    ).toMatchObject({ ok: false, code: "locked" });
    expect(
      await auth.signIn({
        employeeNumber: "L1001",
        pin: "482916",
        ip: "198.51.100.11",
      }),
    ).toMatchObject({ ok: false, code: "locked" });

    const { data: p } = await w.sa
      .from("profiles")
      .select("locked_until")
      .eq("id", d.id)
      .single();
    expect(new Date(p!.locked_until!).getTime()).toBeGreaterThan(Date.now());
    const { data: audit } = await w.sa
      .from("audit_logs")
      .select("reason")
      .eq("entity_id", d.id)
      .eq("entity_type", "profiles");
    expect(audit!.some((a) => a.reason?.startsWith("sign-in lockout"))).toBe(
      true,
    );

    // attempts are stored hashed only
    const { data: rows } = await w.sa
      .from("auth_login_attempts")
      .select("employee_number_attempted, ip_hash")
      .eq("profile_id", d.id);
    expect(rows!.length).toBeGreaterThanOrEqual(5);
    expect(JSON.stringify(rows)).not.toContain("L1001");

    // admin reset restarts the count and clears the lock
    await w.sa.rpc("auth_issue_pin_flags", {
      p_target: d.id,
      p_actor: boot.id,
      p_mode: "reset",
    });
    await w.sa.auth.admin.updateUserById(d.id, { password: "073519" });
    expect(
      await auth.signIn({
        employeeNumber: "L1001",
        pin: "073519",
        ip: "198.51.100.12",
      }),
    ).toEqual({ ok: true, next: "/change-pin" });
  });

  it("unknown employee numbers lock exactly like real ones", async () => {
    const auth = driverAuthFor(w);
    const r: unknown[] = [];
    for (let i = 0; i < 6; i++)
      r.push(
        await auth.signIn({
          employeeNumber: "NOSUCH1",
          pin: "999111",
          ip: "198.51.100.20",
        }),
      );
    expect(r.slice(0, 4)).toEqual(
      Array(4).fill({ ok: false, code: "invalid_credentials" }),
    );
    expect(r[4]).toMatchObject({ code: "locked" });
  });
});

describe("forced PIN change", () => {
  it("blocks all access until the PIN is changed, enforced by RLS not the UI", async () => {
    const d = await makeDriver(w, "F1001", "482916", { mustChange: true });
    await grant(w, d.id, "driver", w.branchId, boot.id);
    const client = anonClient();
    const auth = driverAuthFor(w, client);
    expect(
      await auth.signIn({
        employeeNumber: "F1001",
        pin: "482916",
        ip: "198.51.100.30",
      }),
    ).toEqual({ ok: true, next: "/change-pin" });

    const perm = () =>
      client.rpc("has_permission", {
        permission_key: "inspection.submit",
        target_branch_id: w.branchId,
      });
    expect((await perm()).data).toBe(false);
    expect((await client.from("branches").select("id")).data).toEqual([]);
    // the driver cannot clear the flag themselves
    await client
      .from("profiles")
      .update({ must_change_pin: false })
      .eq("id", d.id);
    expect(
      (
        await w.sa
          .from("profiles")
          .select("must_change_pin")
          .eq("id", d.id)
          .single()
      ).data!.must_change_pin,
    ).toBe(true);
    expect(
      (await client.rpc("auth_complete_pin_change", { p_profile: d.id })).error,
    ).not.toBeNull();

    expect(await auth.changePin({ newPin: "123456" })).toMatchObject({
      ok: false,
      code: "weak_pin",
    });
    expect(await auth.changePin({ newPin: "482916" })).toEqual({
      ok: false,
      code: "same_pin",
    });
    expect(await auth.changePin({ newPin: "739051" })).toEqual({ ok: true });
    expect((await perm()).data).toBe(true);

    // old PIN no longer works, new one does
    const again = driverAuthFor(w);
    expect(
      await again.signIn({
        employeeNumber: "F1001",
        pin: "482916",
        ip: "198.51.100.31",
      }),
    ).toMatchObject({ ok: false });
    expect(
      await again.signIn({
        employeeNumber: "F1001",
        pin: "739051",
        ip: "198.51.100.31",
      }),
    ).toEqual({ ok: true, next: "/home" });
  });
});

describe("MFA required for administrators and approvers (DEC-34)", () => {
  it("approver and admin sessions get nothing at AAL1 and everything at AAL2", async () => {
    const sup = await makeStaff(w, "sup", "supervisor", w.branchId);
    await grant(w, sup.id, "supervisor", w.branchId, boot.id);
    const aal1 = await signInStaff(sup.email, sup.password, "none");
    expect((await aal1.rpc("current_user_requires_mfa")).data).toBe(true);
    expect(
      (
        await aal1.rpc("has_permission", {
          permission_key: "odometer.exception.approve",
          target_branch_id: w.branchId,
        })
      ).data,
    ).toBe(false);
    expect((await aal1.from("branches").select("id")).data).toEqual([]);

    const aal2 = await signInStaff(sup.email, sup.password, "enrol");
    expect(
      (
        await aal2.rpc("has_permission", {
          permission_key: "odometer.exception.approve",
          target_branch_id: w.branchId,
        })
      ).data,
    ).toBe(true);
  });

  it("a view-only user is not forced into MFA", async () => {
    const sm = await makeStaff(w, "sm", "senior_management", null);
    await grant(w, sm.id, "senior_management", null, boot.id);
    const c = await signInStaff(sm.email, sm.password, "none");
    expect((await c.rpc("current_user_requires_mfa")).data).toBe(false);
    expect(
      (
        await c.rpc("has_permission", {
          permission_key: "reports.view",
          target_branch_id: w.branchId,
        })
      ).data,
    ).toBe(true);
  });

  it("PIN issue/reset: needs AAL2 + driver.manage in the driver's branch, never your own PIN, PIN returned once", async () => {
    const drv = await makeDriver(w, "P1001", "482916");
    await grant(w, drv.id, "driver", w.branchId, boot.id);
    const bm = await makeStaff(w, "bm", "branch_manager", w.branchId);
    await grant(w, bm.id, "branch_manager", w.branchId, boot.id);
    const otherBm = await makeStaff(
      w,
      "bm2",
      "branch_manager",
      w.otherBranchId,
    );
    await grant(w, otherBm.id, "branch_manager", w.otherBranchId, boot.id);

    // AAL1 branch manager: refused
    const bm1 = await signInStaff(bm.email, bm.password, "none");
    expect(
      await driverAuthFor(w, bm1).issuePin({
        targetProfileId: drv.id,
        mode: "reset",
      }),
    ).toEqual({ ok: false, code: "mfa_required" });

    // wrong branch (AAL2): refused
    const other2 = await signInStaff(otherBm.email, otherBm.password, "enrol");
    expect(
      await driverAuthFor(w, other2).issuePin({
        targetProfileId: drv.id,
        mode: "reset",
      }),
    ).toEqual({ ok: false, code: "forbidden" });

    // right branch at AAL2: works, PIN is valid, forced change set, audited with the admin as actor
    const bm2 = await signInStaff(bm.email, bm.password, "enrol");
    const r = await driverAuthFor(w, bm2).issuePin({
      targetProfileId: drv.id,
      mode: "reset",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.pin).toMatch(/^\d{6}$/);
      const fresh = anonClient();
      expect(
        (
          await fresh.auth.signInWithPassword({
            email: drv.email,
            password: r.pin,
          })
        ).error,
      ).toBeNull();
    }
    const { data: p } = await w.sa
      .from("profiles")
      .select("must_change_pin")
      .eq("id", drv.id)
      .single();
    expect(p!.must_change_pin).toBe(true);
    const { data: a } = await w.sa
      .from("audit_logs")
      .select("actor_id, reason, after_values")
      .eq("entity_id", drv.id)
      .eq("reason", "driver PIN reset by administrator");
    expect(a![0]!.actor_id).toBe(bm.id);
    expect(JSON.stringify(a)).not.toMatch(/"pin"|password/);

    // DEC-24: cannot reset own PIN
    expect(
      await driverAuthFor(w, bm2).issuePin({
        targetProfileId: bm.id,
        mode: "reset",
      }),
    ).toEqual({ ok: false, code: "self_reset" });
    // staff targets are not drivers
    expect(
      await driverAuthFor(w, bm2).issuePin({
        targetProfileId: otherBm.id,
        mode: "reset",
      }),
    ).toEqual({ ok: false, code: "not_found" });
  });
});

describe("service-role path is unreachable from clients", () => {
  const admins = [
    [
      "auth_login_counts",
      {
        p_emp_hash: "a".repeat(64),
        p_ip_hash: "b".repeat(64),
        p_window: "15 minutes",
      },
    ],
    [
      "auth_login_record",
      {
        p_company: "",
        p_emp_hash: "a".repeat(64),
        p_profile: "",
        p_ip_hash: "b".repeat(64),
        p_succeeded: false,
      },
    ],
    [
      "auth_lock_profile",
      {
        p_profile: "00000000-0000-0000-0000-000000000000",
        p_until: new Date().toISOString(),
      },
    ],
    [
      "auth_issue_pin_flags",
      {
        p_target: "00000000-0000-0000-0000-000000000000",
        p_actor: "00000000-0000-0000-0000-000000000001",
        p_mode: "reset",
      },
    ],
    [
      "auth_complete_pin_change",
      { p_profile: "00000000-0000-0000-0000-000000000000" },
    ],
  ] as const;

  async function authedClient(): Promise<Db> {
    const sm = await makeStaff(w, "viewer", "senior_management", null);
    await grant(w, sm.id, "senior_management", null, boot.id);
    return signInStaff(sm.email, sm.password, "none");
  }

  it("anon and authenticated clients cannot call any service-role function", async () => {
    const authed = await authedClient();
    for (const client of [anonClient(), authed]) {
      for (const [name, args] of admins) {
        const { error } = await client.rpc(name as never, args as never);
        expect(error, name).not.toBeNull();
      }
    }
  });

  it("clients cannot read or write the attempt log", async () => {
    const authed = await authedClient();
    for (const client of [anonClient(), authed]) {
      const read = await client.from("auth_login_attempts").select("id");
      expect(read.error !== null || (read.data ?? []).length === 0).toBe(true);
      const ins = await client.from("auth_login_attempts").insert({
        employee_number_attempted: "a".repeat(64),
        ip_hash: "b".repeat(64),
        succeeded: true,
      });
      expect(ins.error).not.toBeNull();
    }
  });

  it("the anon key cannot use the Auth admin API", async () => {
    const { error } = await anonClient().auth.admin.listUsers();
    expect(error).not.toBeNull();
  });

  it("the service-role client itself cannot rewrite or delete attempts or audit rows", async () => {
    expect(
      (
        await admin()
          .from("auth_login_attempts")
          .delete()
          .neq("id", "00000000-0000-0000-0000-000000000000")
      ).error,
    ).not.toBeNull();
    expect(
      (
        await admin()
          .from("audit_logs")
          .delete()
          .neq("id", "00000000-0000-0000-0000-000000000000")
      ).error,
    ).not.toBeNull();
  });
});
