import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_AUTH_CONFIG } from "@/modules/identity-access/domain/auth-config";
import { deriveLoginIdentifier } from "@/modules/identity-access/domain/identifiers";
import { DriverAccounts } from "@/modules/identity-access/server/driver-accounts";
import { StaffAccounts } from "@/modules/identity-access/server/staff-accounts";
import { driverAuthFor } from "./driver-auth";
import {
  admin,
  anonClient,
  grant,
  makeBootstrap,
  makeStaff,
  makeWorld,
  SECRET,
  signInStaff,
  type Db,
  type World,
} from "./helpers";

// Slice 2B against real Auth + Postgres (synthetic data only): account creation is one flow with no orphan Auth user,
// temporary credentials force a change, and the permission checks hold end to end.
let w: World;
let boot: Awaited<ReturnType<typeof makeBootstrap>>;

beforeAll(async () => {
  w = await makeWorld();
  boot = await makeBootstrap(w);
});

/** Real admin client, except that every database RPC fails: simulates "Auth user created, database step failed". */
function adminWithFailingRpc(): Db {
  return new Proxy(admin(), {
    get(target, prop, receiver) {
      if (prop === "rpc")
        return async () => ({
          data: null,
          error: { code: "XX000", message: "simulated failure" },
        });
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

async function authUserExists(email: string): Promise<boolean> {
  const { data } = await admin().auth.admin.listUsers({ perPage: 1000 });
  return (data?.users ?? []).some((u) => u.email === email);
}

async function managerClient(
  label: string,
  role: string,
  branchId: string | null,
) {
  const u = await makeStaff(w, label, role, branchId);
  await grant(w, u.id, role, branchId, boot.id);
  return { user: u, db: await signInStaff(u.email, u.password, "enrol") };
}

const accounts = (userClient: Db, adminClient: Db = admin()) =>
  new DriverAccounts({
    admin: adminClient,
    userClient,
    config: DEFAULT_AUTH_CONFIG,
    secret: SECRET,
  });

describe("create driver", () => {
  it("creates the Auth user, profile, driver row and role; the temporary PIN works once and forces a change", async () => {
    const { db } = await managerClient("fa-create", "fleet_admin", null);
    const r = await accounts(db).createDriver({
      branchId: w.branchId,
      employeeNumber: "t0101",
      displayName: "Synthetic Driver 101",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const { data: driver } = await w.sa
      .from("drivers")
      .select("employee_number, branch_id, profile_id")
      .eq("id", r.driverId)
      .single();
    expect(driver).toMatchObject({
      employee_number: "T0101",
      branch_id: w.branchId,
      profile_id: r.userId,
    });
    const { data: profile } = await w.sa
      .from("profiles")
      .select("user_type, must_change_pin, login_identifier")
      .eq("id", r.userId)
      .single();
    expect(profile).toMatchObject({
      user_type: "driver",
      must_change_pin: true,
    });
    expect(profile!.login_identifier).toBe(
      deriveLoginIdentifier(SECRET, w.companyId, "T0101"),
    ); // AD-08: no real email

    // sign in with the temporary PIN: allowed, but only to change it (access_cleared is false until then)
    const client = anonClient();
    const auth = driverAuthFor(w, client);
    expect(
      await auth.signIn({
        employeeNumber: "T0101",
        pin: r.pin,
        ip: "198.51.100.101",
      }),
    ).toEqual({ ok: true, next: "/change-pin" });
    expect((await client.from("drivers").select("id")).data).toEqual([]);
    expect(
      (
        await client.rpc("has_permission", {
          permission_key: "evidence.view",
          target_branch_id: w.branchId,
        })
      ).data,
    ).toBe(false);

    expect(await auth.changePin({ newPin: "739051" })).toEqual({ ok: true });
    expect((await client.from("drivers").select("id")).data).toHaveLength(1); // now they see their own row, only
  });

  it("a duplicate employee number is refused and leaves nothing behind", async () => {
    const { db } = await managerClient("fa-dup", "fleet_admin", null);
    const first = await accounts(db).createDriver({
      branchId: w.branchId,
      employeeNumber: "T0102",
      displayName: "Synthetic Driver 102",
    });
    expect(first.ok).toBe(true);
    const second = await accounts(db).createDriver({
      branchId: w.branchId,
      employeeNumber: "t0102",
      displayName: "Synthetic Duplicate",
    });
    expect(second).toEqual({ ok: false, code: "employee_number_taken" });
    const { count } = await w.sa
      .from("drivers")
      .select("id", { count: "exact", head: true })
      .eq("company_id", w.companyId)
      .eq("employee_number", "T0102");
    expect(count).toBe(1);
  });

  it("no orphan Auth user when the database step fails", async () => {
    const { db } = await managerClient("fa-orphan", "fleet_admin", null);
    const login = deriveLoginIdentifier(SECRET, w.companyId, "T0103");
    const r = await accounts(db, adminWithFailingRpc()).createDriver({
      branchId: w.branchId,
      employeeNumber: "T0103",
      displayName: "Synthetic Driver 103",
    });
    expect(r).toEqual({ ok: false, code: "service_error" });
    expect(await authUserExists(login)).toBe(false);
    const { count } = await w.sa
      .from("profiles")
      .select("id", { count: "exact", head: true })
      .eq("login_identifier", login);
    expect(count).toBe(0);
  });

  it("a supervisor cannot create drivers, and no Auth user is created", async () => {
    const { db } = await managerClient("sup-create", "supervisor", w.branchId);
    const login = deriveLoginIdentifier(SECRET, w.companyId, "T0104");
    expect(
      await accounts(db).createDriver({
        branchId: w.branchId,
        employeeNumber: "T0104",
        displayName: "Synthetic Driver 104",
      }),
    ).toEqual({
      ok: false,
      code: "forbidden",
    });
    expect(await authUserExists(login)).toBe(false);
  });

  it("a branch manager cannot create drivers in another branch", async () => {
    const { db } = await managerClient(
      "bm-create",
      "branch_manager",
      w.branchId,
    );
    expect(
      await accounts(db).createDriver({
        branchId: w.otherBranchId,
        employeeNumber: "T0105",
        displayName: "Synthetic Driver 105",
      }),
    ).toEqual({
      ok: false,
      code: "forbidden",
    });
    const ok = await accounts(db).createDriver({
      branchId: w.branchId,
      employeeNumber: "T0105",
      displayName: "Synthetic Driver 105",
    });
    expect(ok.ok).toBe(true);
  });
});

describe("create and reset staff", () => {
  const staffAccounts = (userClient: Db, adminClient: Db = admin()) =>
    new StaffAccounts({
      admin: adminClient,
      userClient,
      config: DEFAULT_AUTH_CONFIG,
    });

  it("creates a staff account with a generated temporary password that must be changed, then the policy applies to the change", async () => {
    const { db } = await managerClient("sys-create", "system_admin", null);
    const email = `new-staff-${randomUUID().slice(0, 8)}@example.test`;
    const r = await staffAccounts(db).createStaffUser({
      email,
      displayName: "Synthetic Staff",
    });
    expect(r.ok).toBe(true);
    if (!r.ok || !r.temporaryPassword)
      throw new Error("expected a temporary password");
    expect([...r.temporaryPassword].length).toBeGreaterThanOrEqual(12);

    const { data: profile } = await w.sa
      .from("profiles")
      .select("user_type, must_change_pin, email")
      .eq("id", r.userId)
      .single();
    expect(profile).toMatchObject({
      user_type: "staff",
      must_change_pin: true,
      email,
    });

    const client = anonClient();
    expect(
      (
        await client.auth.signInWithPassword({
          email,
          password: r.temporaryPassword,
        })
      ).error,
    ).toBeNull();
    expect((await client.rpc("current_company_id")).data).toBeNull(); // no access until the password is changed

    const own = staffAccounts(client);
    expect(
      await own.changeOwnPassword({ newPassword: "short-pass1" }),
    ).toMatchObject({ ok: false, code: "weak_password" }); // 11 characters
    expect(
      await own.changeOwnPassword({ newPassword: "A-much-better-passw0rd" }),
    ).toEqual({ ok: true });
    expect(
      (
        await w.sa
          .from("profiles")
          .select("must_change_pin")
          .eq("id", r.userId)
          .single()
      ).data!.must_change_pin,
    ).toBe(false);
    expect((await client.rpc("current_company_id")).data).toBe(w.companyId);
  });

  it("no orphan Auth user when the profile step fails", async () => {
    const { db } = await managerClient("sys-orphan", "system_admin", null);
    const email = `orphan-${randomUUID().slice(0, 8)}@example.test`;
    expect(
      await staffAccounts(db, adminWithFailingRpc()).createStaffUser({
        email,
        displayName: "Synthetic Orphan",
      }),
    ).toEqual({
      ok: false,
      code: "service_error",
    });
    expect(await authUserExists(email)).toBe(false);
  });

  it("only users.roles.manage can create staff; a reset forces a change; nobody resets themselves", async () => {
    const fa = await managerClient("fa-staff", "fleet_admin", null);
    const email = `denied-${randomUUID().slice(0, 8)}@example.test`;
    expect(
      await staffAccounts(fa.db).createStaffUser({
        email,
        displayName: "Synthetic Denied",
      }),
    ).toEqual({ ok: false, code: "forbidden" });
    expect(await authUserExists(email)).toBe(false);

    const sys = await managerClient("sys-reset", "system_admin", null);
    const target = await makeStaff(w, "reset-target", "supervisor", w.branchId);
    const reset = await staffAccounts(sys.db).resetStaffPassword({
      targetUserId: target.id,
      newPassword: "Reset-Passw0rd-123",
    });
    expect(reset).toEqual({ ok: true });
    expect(
      (
        await w.sa
          .from("profiles")
          .select("must_change_pin")
          .eq("id", target.id)
          .single()
      ).data!.must_change_pin,
    ).toBe(true);
    expect(
      (
        await anonClient().auth.signInWithPassword({
          email: target.email,
          password: "Reset-Passw0rd-123",
        })
      ).error,
    ).toBeNull();

    expect(
      await staffAccounts(sys.db).resetStaffPassword({
        targetUserId: sys.user.id,
        newPassword: "Reset-Passw0rd-123",
      }),
    ).toEqual({ ok: false, code: "self_reset" });
    expect(
      await staffAccounts(sys.db).resetStaffPassword({
        targetUserId: target.id,
        newPassword: "short",
      }),
    ).toMatchObject({ ok: false, code: "weak_password" });
  });
});
