import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import {
  assignDeviceSchema,
  deviceStatusSchema,
  registerDeviceSchema,
  unassignDeviceSchema,
} from "../domain/device-schema";
import { issueMessages } from "../domain/driver-schema";
import type { DeviceRow } from "../domain/device-schema";
import type { Outcome } from "../domain/outcome";

// The company device register as the SIGNED-IN USER: the SQL functions (migration 041) authorise with driver.manage for the
// device's branch and enforce DEC-24; nothing here uses the service-role key.
type Db = SupabaseClient<Database>;

type E = { code?: string; message?: string };
/** Plain, human messages the database wrote are shown; constraint and SQL text never is. */
export function deviceDbMessage(e: E): string {
  if (e.code === "42501")
    return "You are not allowed to do this. It needs driver.manage for the device's branch, and nobody can change the device assigned to themselves.";
  if (e.code === "P0002") return "That was not found, or you cannot access it.";
  if (
    ["22023", "55000", "23505"].includes(e.code ?? "") &&
    e.message &&
    !/violates|constraint|\bpublic\./i.test(e.message)
  )
    return e.message.charAt(0).toUpperCase() + e.message.slice(1) + ".";
  return "Something went wrong on our side. Please try again.";
}

const invalid = (error: Parameters<typeof issueMessages>[0]) => ({
  ok: false as const,
  message: "Check the details and try again.",
  details: issueMessages(error),
});

export async function registerDevice(
  db: Db,
  raw: unknown,
): Promise<Outcome<{ deviceId: string }>> {
  const p = registerDeviceSchema.safeParse(raw);
  if (!p.success) return invalid(p.error);
  const { data, error } = await db.rpc("register_company_device", {
    p_branch_id: p.data.branchId,
    p_device_key: p.data.deviceKey,
    p_asset_tag: (p.data.assetTag ?? null) as string,
    p_label: (p.data.label ?? null) as string,
  });
  if (error) return { ok: false, message: deviceDbMessage(error) };
  return { ok: true, deviceId: data };
}

export async function assignDevice(db: Db, raw: unknown): Promise<Outcome> {
  const p = assignDeviceSchema.safeParse(raw);
  if (!p.success) return invalid(p.error);
  const { error } = await db.rpc("assign_company_device", {
    p_device_id: p.data.deviceId,
    p_driver_id: p.data.driverId,
    p_reason: p.data.reason,
  });
  return error ? { ok: false, message: deviceDbMessage(error) } : { ok: true };
}

export async function unassignDevice(db: Db, raw: unknown): Promise<Outcome> {
  const p = unassignDeviceSchema.safeParse(raw);
  if (!p.success) return invalid(p.error);
  const { error } = await db.rpc("unassign_company_device", {
    p_device_id: p.data.deviceId,
    p_reason: p.data.reason,
  });
  return error ? { ok: false, message: deviceDbMessage(error) } : { ok: true };
}

export async function setDeviceStatus(db: Db, raw: unknown): Promise<Outcome> {
  const p = deviceStatusSchema.safeParse(raw);
  if (!p.success) return invalid(p.error);
  const { error } = await db.rpc("set_company_device_status", {
    p_device_id: p.data.deviceId,
    p_status: p.data.status,
    p_reason: p.data.reason,
  });
  return error ? { ok: false, message: deviceDbMessage(error) } : { ok: true };
}

export async function listDevices(
  db: Db,
  branchId?: string,
): Promise<Outcome<{ devices: DeviceRow[] }>> {
  const { data, error } = await db.rpc("list_company_devices", {
    p_branch_id: branchId,
  });
  if (error) return { ok: false, message: deviceDbMessage(error) };
  return {
    ok: true,
    devices: (data ?? []).map((r) => ({
      id: r.id,
      branchId: r.branch_id,
      branchName: r.branch_name,
      shortCode: r.short_code,
      assetTag: r.asset_tag || null,
      label: r.label || null,
      status: r.status,
      assignedDriverId: r.assigned_driver_id || null,
      driverEmployeeNumber: r.driver_employee_number || null,
      driverName: r.driver_name || null,
      assignedFrom: r.assigned_from || null,
    })),
  };
}
