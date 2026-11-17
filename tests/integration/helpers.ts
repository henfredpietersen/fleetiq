import { createHmac, randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../src/lib/database.types";
import { deriveLoginIdentifier } from "../../src/modules/identity-access/domain/identifiers";

export type Db = SupabaseClient<Database>;

export const env = {
  url:
    process.env.API_URL ??
    process.env.NEXT_PUBLIC_SUPABASE_URL ??
    "http://127.0.0.1:54321",
  anon: process.env.ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
  service:
    process.env.SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
};
export const SECRET = "integration-test-secret-".padEnd(40, "x");
const noSession = {
  persistSession: false,
  autoRefreshToken: false,
  detectSessionInUrl: false,
};

export const admin = (): Db =>
  createClient<Database>(env.url, env.service, { auth: noSession });
export const anonClient = (): Db =>
  createClient<Database>(env.url, env.anon, { auth: noSession });

export type World = {
  companyId: string;
  branchId: string;
  otherBranchId: string;
  sa: Db;
};

/** Fresh synthetic company with two branches. */
export async function makeWorld(): Promise<World> {
  const sa = admin();
  const { data: c } = await sa
    .from("companies")
    .insert({ name: `Synthetic ${randomUUID()}` })
    .select("id")
    .single();
  const companyId = c!.id;
  const mk = async (code: string) =>
    (
      await sa
        .from("branches")
        .insert({ company_id: companyId, name: code, branch_code: code })
        .select("id")
        .single()
    ).data!.id;
  return {
    companyId,
    branchId: await mk("B1"),
    otherBranchId: await mk("B2"),
    sa,
  };
}

async function roleId(sa: Db, name: string) {
  return (
    await sa
      .from("roles")
      .select("id")
      .eq("name", name)
      .is("company_id", null)
      .single()
  ).data!.id;
}

export async function grant(
  w: World,
  userId: string,
  role: string,
  branchId: string | null,
  grantedBy: string,
) {
  const { error } = await w.sa.from("user_roles").insert({
    user_id: userId,
    role_id: await roleId(w.sa, role),
    company_id: w.companyId,
    branch_id: branchId,
    granted_by: grantedBy,
    effective_from: new Date(Date.now() - 3600_000).toISOString(),
  });
  if (error) throw error;
}

export async function makeStaff(
  w: World,
  label: string,
  role: string,
  branchId: string | null,
) {
  const email = `${label}-${randomUUID().slice(0, 8)}@example.test`;
  const password = "Synthetic-Passw0rd!";
  const { data } = await w.sa.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  const id = data.user!.id;
  await w.sa.from("profiles").insert({
    id,
    company_id: w.companyId,
    display_name: label,
    email,
    user_type: "staff",
    login_identifier: email,
  });
  return { id, email, password, role, branchId };
}

export async function makeDriver(
  w: World,
  empNo: string,
  pin: string,
  opts: { mustChange?: boolean; branchId?: string } = {},
) {
  const email = deriveLoginIdentifier(SECRET, w.companyId, empNo);
  const { data } = await w.sa.auth.admin.createUser({
    email,
    password: pin,
    email_confirm: true,
  });
  const id = data.user!.id;
  await w.sa.from("profiles").insert({
    id,
    company_id: w.companyId,
    display_name: `Driver ${empNo}`,
    user_type: "driver",
    login_identifier: email,
    must_change_pin: opts.mustChange ?? false,
  });
  return { id, empNo, pin, email };
}

/** Bootstrap grantor (grants need a granted_by profile that is not the grantee). */
export async function makeBootstrap(w: World) {
  return makeStaff(w, "bootstrap", "system_admin", null);
}

// --- minimal RFC 6238 TOTP so tests can complete real MFA against GoTrue
function base32(s: string): Buffer {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of s.replace(/=+$/, "").toUpperCase())
    bits += A.indexOf(ch).toString(2).padStart(5, "0");
  const bytes = bits.match(/.{8}/g) ?? [];
  return Buffer.from(bytes.map((b) => parseInt(b, 2)));
}
export function totp(secret: string, at = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const h = createHmac("sha1", base32(secret)).update(counter).digest();
  const o = h[h.length - 1]! & 0xf;
  const code = ((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000)
    .toString()
    .padStart(6, "0");
  return code;
}

/** Sign in as staff, enrol + verify TOTP, returning an AAL2 client. */
export async function signInStaff(
  email: string,
  password: string,
  mfa: "none" | "enrol",
): Promise<Db> {
  const c = anonClient();
  const { error } = await c.auth.signInWithPassword({ email, password });
  if (error) throw error;
  if (mfa === "enrol") {
    const { data: f, error: e1 } = await c.auth.mfa.enroll({
      factorType: "totp",
    });
    if (e1) throw e1;
    const { data: ch } = await c.auth.mfa.challenge({ factorId: f.id });
    const { error: e2 } = await c.auth.mfa.verify({
      factorId: f.id,
      challengeId: ch!.id,
      code: totp(f.totp.secret),
    });
    if (e2) throw e2;
  }
  return c;
}
