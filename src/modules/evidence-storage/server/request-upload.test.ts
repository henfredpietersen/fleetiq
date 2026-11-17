import { describe, expect, it } from "vitest";
import { DEFAULT_EVIDENCE_CONFIG } from "../domain/evidence-config";
import { called, fakeClient } from "@/test/fake-supabase";
import { requestUploadSlot } from "./request-upload";

const BRANCH = "33333333-3333-4333-8333-333333333333";
const CSID = "66666666-6666-4666-8666-666666666666";
const input = (over: Record<string, unknown> = {}) => ({
  purpose: "odometer",
  branchId: BRANCH,
  captureSource: "in_app_camera",
  mimeType: "image/jpeg",
  sizeBytes: 250_000,
  clientSubmissionId: CSID,
  ...over,
});
const slotRow = (over: Record<string, unknown> = {}) => ({
  id: "22222222-2222-4222-8222-222222222222",
  status: "issued",
  bucket: "evidence",
  object_path: "co/branch/odometer/obj.jpg",
  expires_at: new Date(Date.now() + 900_000).toISOString(),
  evidence_file_id: null,
  ...over,
});
const run = (
  raw: unknown,
  f = fakeClient({
    rpc: { request_evidence_upload_slot: () => ({ data: slotRow() }) },
  }),
) =>
  requestUploadSlot(
    { db: f.client, config: DEFAULT_EVIDENCE_CONFIG },
    raw,
  ).then((r) => ({ r, f }));

describe("requestUploadSlot", () => {
  it("returns a signed upload URL for the server-chosen path", async () => {
    const { r, f } = await run(input());
    expect(r).toMatchObject({
      ok: true,
      slot: {
        objectPath: "co/branch/odometer/obj.jpg",
        token: "tok",
        alreadyUploaded: false,
      },
    });
    expect(called(f.calls, "createSignedUploadUrl")[0]!.args).toEqual([
      "evidence",
      "co/branch/odometer/obj.jpg",
    ]);
    expect(
      called(f.calls, "rpc:request_evidence_upload_slot")[0]!.args[0],
    ).toMatchObject({
      p_purpose: "odometer",
      p_branch_id: BRANCH,
      p_client_submission_id: CSID,
      p_ttl_minutes: DEFAULT_EVIDENCE_CONFIG.uploadSlotMinutes,
    });
  });

  it("validates before asking the database: wrong MIME, oversize, bad ids, unknown purpose, forged source", async () => {
    const bad: [Record<string, unknown>, string][] = [
      [{ mimeType: "application/pdf" }, "MIME_NOT_ALLOWED"],
      [{ mimeType: "text/html" }, "MIME_NOT_ALLOWED"],
      [{ sizeBytes: DEFAULT_EVIDENCE_CONFIG.maxBytes + 1 }, "TOO_LARGE"],
      [{ sizeBytes: 0 }, "INVALID_INPUT"],
      [{ sizeBytes: 1.5 }, "INVALID_INPUT"],
      [{ clientSubmissionId: "not-a-uuid" }, "INVALID_INPUT"],
      [{ branchId: "../x" }, "INVALID_INPUT"],
      [{ purpose: "nonsense" }, "INVALID_INPUT"],
      [{ captureSource: "import" }, "INVALID_INPUT"], // server-only source
      [{ deviceCaptureAt: "yesterday-ish" }, "INVALID_INPUT"],
    ];
    for (const [over, code] of bad) {
      const { r, f } = await run(input(over));
      expect(r, JSON.stringify(over)).toMatchObject({ ok: false, code });
      expect(called(f.calls, "rpc:request_evidence_upload_slot")).toHaveLength(
        0,
      );
    }
  });

  it("permission failures from the database surface as FORBIDDEN and issue no URL", async () => {
    const f = fakeClient({
      rpc: {
        request_evidence_upload_slot: () => ({
          error: { code: "42501", message: "nope" },
        }),
      },
    });
    const { r } = await run(input(), f);
    expect(r).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(called(f.calls, "createSignedUploadUrl")).toHaveLength(0);
  });

  it("reusing a client_submission_id for a different upload is a CONFLICT", async () => {
    const f = fakeClient({
      rpc: {
        request_evidence_upload_slot: () => ({
          error: {
            code: "22023",
            message:
              "client_submission_id was already used for a different upload",
          },
        }),
      },
    });
    expect((await run(input(), f)).r).toMatchObject({
      ok: false,
      code: "CONFLICT",
    });
  });

  it("retry after the file was uploaded: no new URL, go straight to registration", async () => {
    const f = fakeClient({
      rpc: { request_evidence_upload_slot: () => ({ data: slotRow() }) },
      signedUpload: {
        error: { message: "The resource already exists", statusCode: "409" },
      },
    });
    expect((await run(input(), f)).r).toMatchObject({
      ok: true,
      slot: {
        alreadyUploaded: true,
        uploadUrl: null,
        alreadyRegistered: false,
      },
    });
  });

  it("retry after registration: returns the same evidence id and never opens a new upload", async () => {
    const f = fakeClient({
      rpc: {
        request_evidence_upload_slot: () => ({
          data: slotRow({
            status: "registered",
            evidence_file_id: "55555555-5555-4555-8555-555555555555",
          }),
        }),
      },
    });
    const { r } = await run(input(), f);
    expect(r).toMatchObject({
      ok: true,
      slot: {
        alreadyRegistered: true,
        evidenceFileId: "55555555-5555-4555-8555-555555555555",
        uploadUrl: null,
      },
    });
    expect(called(f.calls, "createSignedUploadUrl")).toHaveLength(0);
  });

  it("storage trouble is UNAVAILABLE (retryable), not a crash", async () => {
    const f = fakeClient({
      rpc: { request_evidence_upload_slot: () => ({ data: slotRow() }) },
      signedUpload: { error: { message: "boom", statusCode: "500" } },
    });
    expect((await run(input(), f)).r).toMatchObject({
      ok: false,
      code: "UNAVAILABLE",
    });
  });
});
