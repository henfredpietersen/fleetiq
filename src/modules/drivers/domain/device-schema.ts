// Input rules for the company device register (DEC-35, migration 041). zod on the server before the SQL functions; the database
// re-checks everything (driver.manage for the branch, never your own device, one issued device per driver).
import { z } from "zod";
import { parseDeviceKeyInput } from "@/modules/evidence-storage/domain/device-key";

const uuid = z.uuid("Invalid identifier");
const reason = z
  .string()
  .trim()
  .min(1, "A reason is required")
  .max(500, "A reason can be at most 500 characters");
const optionalText = (max: number) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().trim().max(max, `At most ${max} characters`).optional(),
  );

export const registerDeviceSchema = z.object({
  branchId: uuid,
  /** What the administrator types or pastes from the phone's "This phone" screen. */
  deviceKey: z.string().transform((v, ctx) => {
    const k = parseDeviceKeyInput(v);
    if (!k) {
      ctx.addIssue({
        code: "custom",
        message:
          "That is not a device code. Copy the full code from the phone's “This phone” screen.",
      });
      return z.NEVER;
    }
    return k;
  }),
  assetTag: optionalText(60),
  label: optionalText(100),
});
export const assignDeviceSchema = z.object({
  deviceId: uuid,
  driverId: uuid,
  reason,
});
export const unassignDeviceSchema = z.object({ deviceId: uuid, reason });
export const deviceStatusSchema = z.object({
  deviceId: uuid,
  status: z.enum(["active", "lost", "retired"]),
  reason,
});

export const DEVICE_STATUS_LABEL: Record<string, string> = {
  active: "Active",
  lost: "Lost",
  retired: "Retired",
};

/** DEC-35 flags shown to supervisors. Never a refusal. */
export const DEVICE_FLAG_LABEL: Record<string, string> = {
  issued_device: "Issued phone",
  other_device: "Another phone",
  unknown_device: "Unknown phone",
  no_issued_device: "No phone issued",
};

export type DeviceRow = {
  id: string;
  branchId: string;
  branchName: string;
  shortCode: string;
  assetTag: string | null;
  label: string | null;
  status: string;
  assignedDriverId: string | null;
  driverEmployeeNumber: string | null;
  driverName: string | null;
  assignedFrom: string | null;
};
