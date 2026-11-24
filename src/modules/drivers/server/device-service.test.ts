import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import {
  assignDevice,
  deviceDbMessage,
  registerDevice,
  setDeviceStatus,
  unassignDevice,
} from "./device-service";

// Permissions, DEC-24 and the one-device-per-driver rule are proved in phase4b_company_devices.test.sql; this proves validation
// first, the right function with the right arguments, and that database messages are shown without SQL text.
function fake(
  reply: {
    data?: unknown;
    error?: { code?: string; message?: string } | null;
  } = {},
) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const db = {
    rpc: (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return Promise.resolve({
        data: reply.data ?? null,
        error: reply.error ?? null,
      });
    },
  } as unknown as SupabaseClient<Database>;
  return { db, calls };
}
const B = "5eed0000-0000-4000-8000-0000000000b1";
const D = "5eed0000-0000-4000-8000-000000000d01";
const DR = "5eed0000-0000-4000-8000-000000000301";
const KEY = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

describe("company device register service", () => {
  it("registerDevice accepts the code as typed (dashes, case, spaces) and sends blanks as NULL", async () => {
    const { db, calls } = fake({ data: D });
    const r = await registerDevice(db, {
      branchId: B,
      deviceKey: `  ${KEY.toUpperCase().replace(/-/g, "")} `,
      assetTag: "  ",
      label: "Hilux phone",
    });
    expect(r).toEqual({ ok: true, deviceId: D });
    expect(calls[0]).toEqual({
      name: "register_company_device",
      args: {
        p_branch_id: B,
        p_device_key: KEY,
        p_asset_tag: null,
        p_label: "Hilux phone",
      },
    });
  });
  it("validates first: a bad code, branch or empty reason calls nothing", async () => {
    const { db, calls } = fake();
    expect(
      (await registerDevice(db, { branchId: B, deviceKey: "nope" })).ok,
    ).toBe(false);
    expect(
      (await registerDevice(db, { branchId: "x", deviceKey: KEY })).ok,
    ).toBe(false);
    expect(
      (await assignDevice(db, { deviceId: D, driverId: DR, reason: " " })).ok,
    ).toBe(false);
    expect((await unassignDevice(db, { deviceId: D, reason: "" })).ok).toBe(
      false,
    );
    expect(
      (
        await setDeviceStatus(db, {
          deviceId: D,
          status: "stolen",
          reason: "x",
        })
      ).ok,
    ).toBe(false);
    expect(calls).toHaveLength(0);
  });
  it("assign / unassign / status call their functions with the reason", async () => {
    const { db, calls } = fake();
    await assignDevice(db, { deviceId: D, driverId: DR, reason: "Issued" });
    await unassignDevice(db, { deviceId: D, reason: "Returned" });
    await setDeviceStatus(db, {
      deviceId: D,
      status: "lost",
      reason: "Reported lost",
    });
    expect(calls.map((c) => c.name)).toEqual([
      "assign_company_device",
      "unassign_company_device",
      "set_company_device_status",
    ]);
    expect(calls[2]!.args).toEqual({
      p_device_id: D,
      p_status: "lost",
      p_reason: "Reported lost",
    });
  });
  it("shows the database's plain message, never SQL or constraint text", () => {
    expect(
      deviceDbMessage({
        code: "55000",
        message: "this device is already assigned: unassign it first",
      }),
    ).toBe("This device is already assigned: unassign it first.");
    expect(
      deviceDbMessage({
        code: "23505",
        message:
          'duplicate key value violates unique constraint "company_devices_key_uq"',
      }),
    ).toBe("Something went wrong on our side. Please try again.");
    expect(deviceDbMessage({ code: "42501", message: "x" })).toMatch(
      /driver\.manage/,
    );
  });
});
