import { describe, expect, it } from "vitest";
import {
  recordLicence,
  setDriverStatus,
  updateDriver,
  verifyLicence,
} from "./driver-service";

const ID = "11111111-1111-4111-8111-111111111111";

function db(
  result: {
    data?: unknown;
    error?: { code?: string; message?: string } | null;
  } = {},
) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  return {
    calls,
    client: {
      rpc: async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        return { data: result.data ?? null, error: result.error ?? null };
      },
    } as never,
  };
}

const licence = {
  driverId: ID,
  licenceNumber: "SYN0000001",
  licenceCode: "EB",
  issueDate: "2022-01-10",
  expiryDate: "2027-01-10",
  clientSubmissionId: ID,
};

describe("recordLicence", () => {
  it("validates before calling the database (expiry must follow issue)", async () => {
    const { client, calls } = db();
    const r = await recordLicence(client, {
      ...licence,
      expiryDate: "2022-01-10",
    });
    expect(r.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it("calls record_driver_licence with the normalised values and returns the new id", async () => {
    const { client, calls } = db({ data: "lic-1" });
    const r = await recordLicence(client, {
      ...licence,
      licenceCode: "eb",
      prdpRequired: "on",
      prdpExpiryDate: "2027-05-05",
      evidenceFileId: ID,
    });
    expect(r).toEqual({ ok: true, licenceId: "lic-1", driverId: ID });
    expect(calls[0].name).toBe("record_driver_licence");
    expect(calls[0].args).toMatchObject({
      p_licence_code: "EB",
      p_prdp_required: true,
      p_prdp_expiry_date: "2027-05-05",
      p_evidence_file_id: ID,
      p_client_submission_id: ID,
    });
  });

  it("maps a database refusal to a safe message (no SQL, no licence number)", async () => {
    const { client } = db({
      error: {
        code: "42501",
        message:
          "missing permission driver.manage and driver.licence.view_sensitive",
      },
    });
    const r = await recordLicence(client, licence);
    expect(r).toEqual({
      ok: false,
      message: "You are not allowed to do this.",
    });
  });
});

describe("verifyLicence", () => {
  it("surfaces the DEC-24 refusal from the database", async () => {
    const { client } = db({
      error: {
        code: "42501",
        message: "nobody verifies a record they created (DEC-24)",
      },
    });
    const r = await verifyLicence(client, {
      licenceId: ID,
      driverId: ID,
      decision: "verified",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/created yourself/);
  });

  it("rejecting without a reason never reaches the database", async () => {
    const { client, calls } = db();
    const r = await verifyLicence(client, {
      licenceId: ID,
      driverId: ID,
      decision: "rejected",
    });
    expect(r.ok).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("updateDriver / setDriverStatus", () => {
  it("requires a reason to deactivate and passes it on", async () => {
    const none = db();
    expect(
      (
        await setDriverStatus(none.client, {
          driverId: ID,
          status: "inactive",
          reason: "",
        })
      ).ok,
    ).toBe(false);
    expect(none.calls).toEqual([]);
    const some = db();
    expect(
      await setDriverStatus(some.client, {
        driverId: ID,
        status: "inactive",
        reason: "Left the company",
      }),
    ).toEqual({ ok: true, driverId: ID, status: "inactive" });
    expect(some.calls[0]).toEqual({
      name: "set_driver_status",
      args: {
        p_driver_id: ID,
        p_status: "inactive",
        p_reason: "Left the company",
      },
    });
  });

  it("updates name and phone through update_driver_details only", async () => {
    const { client, calls } = db();
    expect(
      (
        await updateDriver(client, {
          driverId: ID,
          displayName: " Synthetic Driver ",
          phone: "",
        })
      ).ok,
    ).toBe(true);
    expect(calls[0].name).toBe("update_driver_details");
    expect(calls[0].args.p_display_name).toBe("Synthetic Driver");
  });
});
