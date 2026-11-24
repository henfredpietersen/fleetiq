"use server";
// Server actions for the company device register: session first (including MFA for staff, DEC-34), then the SQL functions
// authorise as the signed-in user (driver.manage for the branch; DEC-24).
import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireSession } from "@/modules/identity-access/server/session";
import * as service from "./device-service";

export type DeviceReply =
  | { ok: true; message: string }
  | { ok: false; message: string; details?: string[] };

async function run(
  f: (
    db: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  ) => Promise<{ ok: boolean; message?: string; details?: string[] }>,
  done: string,
): Promise<DeviceReply> {
  await requireSession("full");
  const r = await f(await createSupabaseServerClient());
  if (!r.ok)
    return { ok: false, message: r.message ?? "Not done.", details: r.details };
  revalidatePath("/drivers/devices");
  return { ok: true, message: done };
}

export async function registerDeviceAction(input: unknown) {
  return run((db) => service.registerDevice(db, input), "Phone registered.");
}
export async function assignDeviceAction(input: unknown) {
  return run((db) => service.assignDevice(db, input), "Phone assigned.");
}
export async function unassignDeviceAction(input: unknown) {
  return run((db) => service.unassignDevice(db, input), "Phone unassigned.");
}
export async function setDeviceStatusAction(input: unknown) {
  return run((db) => service.setDeviceStatus(db, input), "Status updated.");
}
