import { describe, expect, it } from "vitest";
import { assignRole, revokeRole } from "./role-assignments";

const CALLER = "c0000000-0000-4000-8000-000000000001";
const OTHER = "c0000000-0000-4000-8000-000000000002";
const ROLE = "r0000000-0000-4000-8000-000000000001";
const BRANCH = "22222222-2222-4222-8222-222222222222";

type Opts = {
  caller?: string | null;
  company?: string | null;
  insertError?: { code?: string } | null;
  grant?: {
    id: string;
    user_id: string;
    effective_from: string;
    effective_to: string | null;
  } | null;
  updatedRows?: { id: string }[];
  updateError?: { code?: string } | null;
};

function fake(o: Opts = {}) {
  const inserted: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  const cfg = {
    caller: CALLER as string | null,
    company: "co-1" as string | null,
    insertError: null,
    grant: {
      id: "g1",
      user_id: OTHER,
      effective_from: "2026-01-01T00:00:00Z",
      effective_to: null,
    } as Opts["grant"],
    updatedRows: [{ id: "g1" }],
    updateError: null,
    ...o,
  };
  const db = {
    auth: {
      getUser: async () => ({
        data: { user: cfg.caller ? { id: cfg.caller } : null },
      }),
    },
    rpc: async () => ({ data: cfg.company, error: null }),
    from: () => ({
      insert: async (row: Record<string, unknown>) => {
        inserted.push(row);
        return { error: cfg.insertError };
      },
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: cfg.grant, error: null }),
        }),
      }),
      update: (patch: Record<string, unknown>) => {
        updates.push(patch);
        return {
          eq: () => ({
            select: async () => ({
              data: cfg.updateError ? null : cfg.updatedRows,
              error: cfg.updateError,
            }),
          }),
        };
      },
    }),
  };
  return { db: db as never, inserted, updates };
}

describe("assignRole", () => {
  it("inserts a grant granted_by the caller, in the caller's company, with branch scope", async () => {
    const { db, inserted } = fake();
    expect(
      await assignRole(db, { userId: OTHER, roleId: ROLE, branchId: BRANCH }),
    ).toEqual({ ok: true });
    expect(inserted).toEqual([
      {
        user_id: OTHER,
        role_id: ROLE,
        company_id: "co-1",
        branch_id: BRANCH,
        granted_by: CALLER,
      },
    ]);
  });

  it("company-wide scope is branch_id null", async () => {
    const { db, inserted } = fake();
    await assignRole(db, { userId: OTHER, roleId: ROLE, branchId: null });
    expect(inserted[0].branch_id).toBeNull();
  });

  it("a user cannot change their own roles (and nothing is sent to the database)", async () => {
    const { db, inserted } = fake();
    expect(
      await assignRole(db, { userId: CALLER, roleId: ROLE, branchId: null }),
    ).toEqual({ ok: false, code: "self_change" });
    expect(inserted).toEqual([]);
  });

  it("maps the database's refusals (RLS / constraints) to stable codes", async () => {
    expect(
      await assignRole(fake({ insertError: { code: "42501" } }).db, {
        userId: OTHER,
        roleId: ROLE,
        branchId: null,
      }),
    ).toEqual({ ok: false, code: "forbidden" });
    expect(
      await assignRole(fake({ insertError: { code: "23514" } }).db, {
        userId: OTHER,
        roleId: ROLE,
        branchId: null,
      }),
    ).toEqual({ ok: false, code: "invalid_input" });
    expect(
      await assignRole(fake({ insertError: { code: "XX000" } }).db, {
        userId: OTHER,
        roleId: ROLE,
        branchId: null,
      }),
    ).toEqual({ ok: false, code: "service_error" });
  });

  it("requires a session", async () => {
    expect(
      await assignRole(fake({ caller: null }).db, {
        userId: OTHER,
        roleId: ROLE,
        branchId: null,
      }),
    ).toEqual({ ok: false, code: "unauthenticated" });
  });
});

describe("revokeRole", () => {
  it("ends a running grant in the past (never deletes)", async () => {
    const { db, updates } = fake();
    expect(await revokeRole(db, { grantId: "g1" })).toEqual({ ok: true });
    const end = new Date(updates[0].effective_to as string).getTime();
    expect(end).toBeLessThanOrEqual(Date.now());
  });

  it("cancels a not-yet-started grant by collapsing it to zero length", async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const { db, updates } = fake({
      grant: {
        id: "g1",
        user_id: OTHER,
        effective_from: future,
        effective_to: null,
      },
    });
    await revokeRole(db, { grantId: "g1" });
    expect(updates[0].effective_to).toBe(future);
  });

  it("refuses your own grant, and reports RLS-hidden rows as forbidden", async () => {
    const own = fake({
      grant: {
        id: "g1",
        user_id: CALLER,
        effective_from: "2026-01-01T00:00:00Z",
        effective_to: null,
      },
    });
    expect(await revokeRole(own.db, { grantId: "g1" })).toEqual({
      ok: false,
      code: "self_change",
    });
    expect(own.updates).toEqual([]);
    expect(
      await revokeRole(fake({ updatedRows: [] }).db, { grantId: "g1" }),
    ).toEqual({ ok: false, code: "forbidden" });
  });

  it("unknown grant", async () => {
    expect(
      await revokeRole(fake({ grant: null }).db, { grantId: "nope" }),
    ).toEqual({ ok: false, code: "not_found" });
  });
});
