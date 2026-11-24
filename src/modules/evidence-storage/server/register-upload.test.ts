import { describe, expect, it } from "vitest";
import {
  DEFAULT_EVIDENCE_CONFIG,
  type EvidenceConfig,
} from "../domain/evidence-config";
import { bytes, contains, GPS_LAT, jpeg, png, tiff } from "../domain/fixtures";
import { sha256Hex } from "../domain/image";
import { called, fakeClient, names } from "@/test/fake-supabase";
import { registerUpload } from "./register-upload";

const USER = "11111111-1111-4111-8111-111111111111";
const SLOT = "22222222-2222-4222-8222-222222222222";
const BRANCH = "33333333-3333-4333-8333-333333333333";
const PATH = "co/branch/odometer/obj.jpg";

const slotRow = (over: Record<string, unknown> = {}) => ({
  id: SLOT,
  status: "issued",
  bucket: "evidence",
  object_path: PATH,
  purpose: "odometer",
  branch_id: BRANCH,
  declared_mime_type: "image/jpeg",
  expires_at: new Date(Date.now() + 600_000).toISOString(),
  evidence_file_id: null,
  ...over,
});

function setup(opts: {
  object?: Uint8Array;
  slot?: Record<string, unknown> | null;
  allowed?: boolean;
  objectSize?: number;
  config?: Partial<EvidenceConfig>;
  user?: { id: string } | null;
}) {
  const user = fakeClient({
    user: opts.user,
    slot: opts.slot === undefined ? slotRow() : opts.slot,
    rpc: { evidence_upload_allowed: () => ({ data: opts.allowed ?? true }) },
  });
  const elevated = fakeClient({
    objects: opts.object ? { [PATH]: opts.object } : {},
    objectSize: opts.objectSize,
    rpc: {
      register_evidence_file: () => ({
        data: "44444444-4444-4444-8444-444444444444",
      }),
    },
  });
  let elevatedBuilt = 0;
  const deps = {
    db: user.client,
    admin: () => {
      elevatedBuilt++;
      return elevated.client;
    },
    config: { ...DEFAULT_EVIDENCE_CONFIG, ...opts.config },
  };
  return { deps, user, elevated, built: () => elevatedBuilt };
}

describe("registerUpload — verify, then register", () => {
  it("happy path: strips GPS, hashes the STORED bytes itself, records facts, registers once", async () => {
    const original = jpeg({ exif: tiff({ le: true }), xmp: true });
    const { deps, elevated } = setup({ object: original });
    const r = await registerUpload(deps, { slotId: SLOT });
    expect(r).toMatchObject({
      ok: true,
      evidence: {
        alreadyRegistered: false,
        mimeType: "image/jpeg",
        width: 640,
        height: 480,
        exifGpsStripped: true,
      },
    });

    const rewritten = called(elevated.calls, "upload")[0]!
      .args[2] as Uint8Array;
    expect(contains(rewritten, GPS_LAT)).toBe(false); // GPS gone from what is stored
    expect(elevated.objects[PATH]).toEqual(rewritten);
    const reg = called(elevated.calls, "rpc:register_evidence_file")[0]!
      .args[0] as Record<string, unknown>;
    expect(reg).toMatchObject({
      p_slot_id: SLOT,
      p_user_id: USER,
      p_sha256: sha256Hex(rewritten), // server-computed over the stripped file…
      p_size_bytes: rewritten.length,
      p_exif_gps_stripped: true,
    });
    expect(reg.p_sha256).not.toBe(sha256Hex(original)); // …not over the original upload
  });

  it("a clean file is not rewritten", async () => {
    const { deps, elevated } = setup({ object: jpeg({}) });
    expect((await registerUpload(deps, { slotId: SLOT })).ok).toBe(true);
    expect(called(elevated.calls, "upload")).toHaveLength(0);
  });

  it("flag off (DEC-29 is Proposed): file is stored as uploaded and recorded as not stripped", async () => {
    const original = jpeg({ exif: tiff({ le: true }) });
    const { deps, elevated } = setup({
      object: original,
      config: { stripExifGps: false },
    });
    const r = await registerUpload(deps, { slotId: SLOT });
    expect(r.ok && r.evidence.exifGpsStripped).toBe(false);
    expect(called(elevated.calls, "upload")).toHaveLength(0);
    const reg = called(elevated.calls, "rpc:register_evidence_file")[0]!
      .args[0] as Record<string, unknown>;
    expect(reg.p_sha256).toBe(sha256Hex(original));
  });

  it("rejects the wrong MIME: the bytes decide, not the declaration", async () => {
    for (const body of [
      bytes("%PDF-1.7 not an image"),
      bytes("<script>alert(1)</script>"),
      bytes("GIF89a...."),
    ]) {
      const { deps, elevated } = setup({ object: body });
      const r = await registerUpload(deps, { slotId: SLOT });
      expect(r).toMatchObject({ ok: false, code: "MIME_NOT_ALLOWED" });
      expect(called(elevated.calls, "rpc:register_evidence_file")).toHaveLength(
        0,
      );
    }
  });

  it("rejects a valid image of a different type than declared", async () => {
    const { deps, elevated } = setup({ object: png({}) }); // slot declared image/jpeg
    expect(await registerUpload(deps, { slotId: SLOT })).toMatchObject({
      ok: false,
      code: "MIME_MISMATCH",
    });
    expect(called(elevated.calls, "rpc:register_evidence_file")).toHaveLength(
      0,
    );
  });

  it("rejects oversize files — before downloading when the size is known", async () => {
    const { deps, elevated } = setup({
      object: jpeg({}),
      objectSize: DEFAULT_EVIDENCE_CONFIG.maxBytes + 1,
    });
    expect(await registerUpload(deps, { slotId: SLOT })).toMatchObject({
      ok: false,
      code: "TOO_LARGE",
    });
    expect(called(elevated.calls, "download")).toHaveLength(0);
  });

  it("rejects oversize bytes even if the reported size was wrong", async () => {
    const { deps } = setup({
      object: jpeg({}),
      config: { maxBytes: 1024 },
      objectSize: 10,
    });
    const big = bytes(jpeg({}), new Array(2000).fill(0));
    const s2 = setup({
      object: big,
      config: { maxBytes: 1024 },
      objectSize: 10,
    });
    expect(await registerUpload(s2.deps, { slotId: SLOT })).toMatchObject({
      ok: false,
      code: "TOO_LARGE",
    });
    expect((await registerUpload(deps, { slotId: SLOT })).ok).toBe(true); // control: small file passes
  });

  it("rejects an empty file, a missing object and a damaged image", async () => {
    expect(
      await registerUpload(setup({ object: new Uint8Array() }).deps, {
        slotId: SLOT,
      }),
    ).toMatchObject({ ok: false, code: "EMPTY_FILE" });
    expect(
      await registerUpload(setup({}).deps, { slotId: SLOT }),
    ).toMatchObject({ ok: false, code: "OBJECT_MISSING" });
    const whole = jpeg({ exif: tiff({ le: true }) });
    const r = await registerUpload(
      setup({ object: whole.subarray(0, whole.length - 10) }).deps,
      { slotId: SLOT },
    );
    expect(r).toMatchObject({ ok: false, code: "INVALID_IMAGE" });
  });

  it("tampered ids: a slot the caller does not own looks like 'not found' and storage is never touched", async () => {
    const { deps, built } = setup({ object: jpeg({}), slot: null }); // RLS hides other users' slots
    expect(await registerUpload(deps, { slotId: SLOT })).toMatchObject({
      ok: false,
      code: "NOT_FOUND",
    });
    expect(built()).toBe(0);
    expect(
      await registerUpload(deps, { slotId: "../../etc/passwd" }),
    ).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await registerUpload(deps, { slotId: undefined })).toMatchObject({
      ok: false,
      code: "INVALID_INPUT",
    });
  });

  it("the object path comes from the server's slot row, never from the request", async () => {
    const { deps, elevated } = setup({ object: jpeg({}) });
    await registerUpload(deps, {
      slotId: SLOT,
      path: "someone/elses.jpg",
      sha256: "0".repeat(64),
    } as { slotId: string });
    expect(called(elevated.calls, "info")[0]!.args[1]).toBe(PATH);
    const reg = called(elevated.calls, "rpc:register_evidence_file")[0]!
      .args[0] as Record<string, unknown>;
    expect(reg.p_sha256).not.toBe("0".repeat(64));
  });

  it("retry after success is idempotent: same id, no storage access, no second row", async () => {
    const { deps, elevated, built } = setup({
      slot: slotRow({
        status: "registered",
        evidence_file_id: "55555555-5555-4555-8555-555555555555",
      }),
    });
    const r = await registerUpload(deps, { slotId: SLOT });
    expect(r).toMatchObject({
      ok: true,
      evidence: {
        evidenceFileId: "55555555-5555-4555-8555-555555555555",
        alreadyRegistered: true,
      },
    });
    expect(built()).toBe(0);
    expect(elevated.calls).toHaveLength(0);
  });

  it("refuses expired and abandoned slots, and a user whose permission ended (elevated client never built)", async () => {
    const expired = setup({
      object: jpeg({}),
      slot: slotRow({ expires_at: new Date(Date.now() - 1000).toISOString() }),
    });
    expect(await registerUpload(expired.deps, { slotId: SLOT })).toMatchObject({
      ok: false,
      code: "SLOT_EXPIRED",
    });
    const abandoned = setup({
      object: jpeg({}),
      slot: slotRow({ status: "abandoned" }),
    });
    expect(
      await registerUpload(abandoned.deps, { slotId: SLOT }),
    ).toMatchObject({ ok: false, code: "SLOT_UNAVAILABLE" });
    const revoked = setup({ object: jpeg({}), allowed: false });
    expect(await registerUpload(revoked.deps, { slotId: SLOT })).toMatchObject({
      ok: false,
      code: "FORBIDDEN",
    });
    for (const s of [expired, abandoned, revoked]) expect(s.built()).toBe(0);
  });

  it("requires a signed-in user", async () => {
    const { deps, built } = setup({ object: jpeg({}), user: null });
    expect(await registerUpload(deps, { slotId: SLOT })).toMatchObject({
      ok: false,
      code: "UNAUTHENTICATED",
    });
    expect(built()).toBe(0);
  });

  it("asks the database's one upload rule for the slot's purpose and branch", async () => {
    const { deps, user } = setup({ object: jpeg({}) });
    await registerUpload(deps, { slotId: SLOT });
    expect(
      called(user.calls, "rpc:evidence_upload_allowed")[0]!.args[0],
    ).toEqual({
      p_purpose: "odometer",
      p_branch_id: BRANCH,
    });
    expect(names(user.calls).indexOf("getUser")).toBeLessThan(
      names(user.calls).indexOf("rpc:evidence_upload_allowed"),
    );
  });
});
