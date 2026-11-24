// Phase 1C integration tests — run against LOCAL Supabase only (synthetic data). They exercise the real
// storage service, storage policies, RLS and SQL functions together with the server steps.
import { createHash, randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_EVIDENCE_CONFIG,
  type EvidenceConfig,
} from "../../src/modules/evidence-storage/domain/evidence-config";
import {
  bytes,
  contains,
  GPS_LAT,
  jpeg,
  png,
  tiff,
} from "../../src/modules/evidence-storage/domain/fixtures";
import { registerUpload } from "../../src/modules/evidence-storage/server/register-upload";
import { requestUploadSlot } from "../../src/modules/evidence-storage/server/request-upload";
import { issueSignedReadUrl } from "../../src/modules/evidence-storage/server/read-url";
import {
  enqueueEvidenceCleanup,
  evidenceCleanupHandler,
  EVIDENCE_CLEANUP_JOB,
} from "../../src/jobs/evidence-cleanup";
import { runDueJobs } from "../../src/jobs/worker";
import {
  admin,
  anonClient,
  grant,
  makeBootstrap,
  makeDriver,
  makeStaff,
  makeWorld,
  signInStaff,
  type Db,
  type World,
} from "./helpers";

const config: EvidenceConfig = { ...DEFAULT_EVIDENCE_CONFIG };
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let w: World;
let w2: World;
let sa: Db; // service role — assertions and reviewed server steps only
let driver1: Db;
let driver2: Db;
let supB1: Db;
let supB2: Db;
let fleet: Db;
let sysadmin: Db;
let fleetOther: Db;
let ids: Record<string, string>;

async function driverClient(
  world: World,
  boot: { id: string },
  emp: string,
  branch: string,
) {
  const d = await makeDriver(world, emp, "482916");
  await grant(world, d.id, "driver", branch, boot.id);
  const c = anonClient();
  const { error } = await c.auth.signInWithPassword({
    email: d.email,
    password: d.pin,
  });
  if (error) throw error;
  return { c, id: d.id };
}
async function staffClient(
  world: World,
  boot: { id: string },
  label: string,
  role: string,
  branch: string | null,
) {
  const s = await makeStaff(world, label, role, branch);
  await grant(world, s.id, role, branch, boot.id);
  return { c: await signInStaff(s.email, s.password, "enrol"), id: s.id };
}

beforeAll(async () => {
  sa = admin();
  w = await makeWorld();
  w2 = await makeWorld();
  const boot = await makeBootstrap(w);
  const boot2 = await makeBootstrap(w2);
  const d1 = await driverClient(w, boot, "E1001", w.branchId);
  const d2 = await driverClient(w, boot, "E1002", w.branchId);
  const s1 = await staffClient(w, boot, "supb1", "supervisor", w.branchId);
  const s2 = await staffClient(w, boot, "supb2", "supervisor", w.otherBranchId);
  const f = await staffClient(w, boot, "fleet", "fleet_admin", null);
  const sys = await staffClient(w, boot, "sysadm", "system_admin", null);
  const fo = await staffClient(w2, boot2, "fleet-other", "fleet_admin", null);
  [driver1, driver2, supB1, supB2, fleet, sysadmin, fleetOther] = [
    d1.c,
    d2.c,
    s1.c,
    s2.c,
    f.c,
    sys.c,
    fo.c,
  ];
  ids = { d1: d1.id, d2: d2.id };
});

/** request slot -> upload bytes with the signed URL -> (optionally) register. */
async function upload(
  db: Db,
  body: Uint8Array,
  over: Record<string, unknown> = {},
  opts: { contentType?: string; cfg?: EvidenceConfig } = {},
) {
  const cfg = opts.cfg ?? config;
  const input = {
    purpose: "odometer",
    branchId: w.branchId,
    captureSource: "in_app_camera",
    mimeType: "image/jpeg",
    sizeBytes: body.length,
    clientSubmissionId: randomUUID(),
    ...over,
  };
  const r = await requestUploadSlot({ db, config: cfg }, input);
  if (!r.ok) return { input, request: r } as const;
  let uploadError: unknown = null;
  if (r.slot.uploadUrl && r.slot.token) {
    const up = await db.storage.from(r.slot.bucket).uploadToSignedUrl(
      r.slot.objectPath,
      r.slot.token,
      new Blob([body as BlobPart], {
        type: opts.contentType ?? "image/jpeg",
      }),
      {
        contentType: opts.contentType ?? "image/jpeg",
      },
    );
    uploadError = up.error;
  }
  return { input, request: r, slot: r.slot, uploadError } as const;
}
const register = (db: Db, slotId: string, cfg = config) =>
  registerUpload({ db, admin: () => sa, config: cfg }, { slotId });
const readUrl = (
  db: Db,
  evidenceFileId: string,
  extra: Record<string, unknown> = {},
) => issueSignedReadUrl({ db, config }, { evidenceFileId, ...extra });
async function logCount(fileId: string) {
  const { count } = await sa
    .from("evidence_access_log")
    .select("*", { count: "exact", head: true })
    .eq("evidence_file_id", fileId);
  return count ?? 0;
}
async function storedBytes(path: string) {
  const { data, error } = await sa.storage.from("evidence").download(path);
  if (error || !data) throw error ?? new Error("missing object");
  return new Uint8Array(await data.arrayBuffer());
}

describe("upload -> verify -> register", () => {
  it("registers evidence: server hashes the stored bytes, strips GPS, records capture source and timestamps", async () => {
    const original = jpeg({ exif: tiff({ le: true }), xmp: true });
    const up = await upload(driver1, original, {
      captureSource: "gallery",
      deviceCaptureAt: "2026-11-10T08:00:00Z",
    });
    expect(up.request.ok).toBe(true);
    expect(up.uploadError).toBeNull();
    const reg = await register(driver1, up.slot!.slotId);
    expect(reg.ok).toBe(true);
    if (!reg.ok) return;

    const { data: row } = await sa
      .from("evidence_files")
      // explicit columns: the capture-location columns are not readable through the table, by design (DEC-29)
      .select(
        "company_id, branch_id, bucket, object_path, mime_type, capture_source, purpose, uploaded_by, exif_gps_stripped, width, height, legal_hold, sha256, size_bytes, device_capture_at, server_received_at, captured_offline, device_id",
      )
      .eq("id", reg.evidence.evidenceFileId)
      .single();
    const stored = await storedBytes(row!.object_path);
    expect(row).toMatchObject({
      company_id: w.companyId,
      branch_id: w.branchId,
      bucket: "evidence",
      mime_type: "image/jpeg",
      capture_source: "gallery",
      purpose: "odometer",
      uploaded_by: ids.d1,
      exif_gps_stripped: true,
      width: 640,
      height: 480,
      legal_hold: false,
    });
    expect(row!.sha256).toBe(sha(stored)); // hash of what is actually stored…
    expect(row!.sha256).not.toBe(sha(original)); // …computed after stripping, by the server
    expect(row!.size_bytes).toBe(stored.length);
    expect(contains(stored, GPS_LAT)).toBe(false);
    expect(contains(stored, "GPSLatitude")).toBe(false);
    expect(new Date(row!.device_capture_at!).toISOString()).toBe(
      "2026-11-10T08:00:00.000Z",
    ); // declared, untrusted
    expect(
      Math.abs(Date.now() - Date.parse(row!.server_received_at)),
    ).toBeLessThan(120_000); // authoritative
    const { data: slotRow } = await sa
      .from("evidence_upload_slots")
      .select("status, evidence_file_id")
      .eq("id", up.slot!.slotId)
      .single();
    expect(slotRow).toEqual({
      status: "registered",
      evidence_file_id: reg.evidence.evidenceFileId,
    });
  });

  it("retries never duplicate: same slot, same evidence id, one row", async () => {
    const body = jpeg({});
    const csid = randomUUID();
    const a = await upload(driver1, body, { clientSubmissionId: csid });
    const again = await requestUploadSlot({ db: driver1, config }, a.input); // client lost the response and retries
    expect(again.ok && again.slot.slotId).toBe(a.slot!.slotId);
    expect(again.ok && again.slot.objectPath).toBe(a.slot!.objectPath);
    expect(again.ok && again.slot.alreadyUploaded).toBe(true); // bytes are already there: just register

    const r1 = await register(driver1, a.slot!.slotId);
    const r2 = await register(driver1, a.slot!.slotId);
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r2.evidence.evidenceFileId).toBe(r1.evidence.evidenceFileId);
    expect(r2.evidence.alreadyRegistered).toBe(true);
    const { count } = await sa
      .from("evidence_files")
      .select("id", { count: "exact", head: true })
      .eq("object_path", a.slot!.objectPath);
    expect(count).toBe(1);

    const afterReg = await requestUploadSlot({ db: driver1, config }, a.input);
    expect(afterReg.ok && afterReg.slot).toMatchObject({
      alreadyRegistered: true,
      evidenceFileId: r1.evidence.evidenceFileId,
      uploadUrl: null,
    });
    // the same key cannot be reused for a different upload
    expect(
      await requestUploadSlot(
        { db: driver1, config },
        { ...a.input, purpose: "damage" },
      ),
    ).toMatchObject({ ok: false, code: "CONFLICT" });
  });

  it("rejects the wrong MIME (bytes are not an image / not the declared type)", async () => {
    const pdf = bytes("%PDF-1.7\n% not an image at all\n");
    const up = await upload(driver1, pdf); // declared image/jpeg, contentType header says jpeg too
    expect(up.uploadError).toBeNull(); // storage accepts it — only the server's byte check catches it
    expect(await register(driver1, up.slot!.slotId)).toMatchObject({
      ok: false,
      code: "MIME_NOT_ALLOWED",
    });
    const wrongKind = await upload(driver1, png({}), {}); // valid PNG, declared JPEG
    expect(await register(driver1, wrongKind.slot!.slotId)).toMatchObject({
      ok: false,
      code: "MIME_MISMATCH",
    });
    for (const s of [up.slot!, wrongKind.slot!]) {
      const { count } = await sa
        .from("evidence_files")
        .select("id", { count: "exact", head: true })
        .eq("object_path", s.objectPath);
      expect(count).toBe(0);
    }
    // the bucket itself also refuses non-image content types
    const slot = await upload(
      driver1,
      pdf,
      {},
      { contentType: "application/pdf" },
    );
    expect(slot.uploadError).toBeTruthy();
    // and the API refuses them before any slot exists
    expect(
      await requestUploadSlot(
        { db: driver1, config },
        {
          ...slot.input,
          mimeType: "application/pdf",
          clientSubmissionId: randomUUID(),
        },
      ),
    ).toMatchObject({ ok: false, code: "MIME_NOT_ALLOWED" });
  });

  it("rejects oversize files: declared too big up front, or bigger than declared at registration", async () => {
    const small: EvidenceConfig = { ...config, maxBytes: 2000 };
    const big = bytes(jpeg({}), new Array(5000).fill(1)); // valid JPEG start, 5 kB
    expect(
      await requestUploadSlot(
        { db: driver1, config: small },
        {
          purpose: "odometer",
          branchId: w.branchId,
          captureSource: "in_app_camera",
          mimeType: "image/jpeg",
          sizeBytes: big.length,
          clientSubmissionId: randomUUID(),
        },
      ),
    ).toMatchObject({ ok: false, code: "TOO_LARGE" });
    const liar = await upload(
      driver1,
      big,
      { sizeBytes: 1000 },
      { cfg: small },
    ); // declares 1 kB, sends 5 kB
    expect(await register(driver1, liar.slot!.slotId, small)).toMatchObject({
      ok: false,
      code: "TOO_LARGE",
    });
    const { count } = await sa
      .from("evidence_files")
      .select("id", { count: "exact", head: true })
      .eq("object_path", liar.slot!.objectPath);
    expect(count).toBe(0);
  });

  it("rejects empty and damaged images", async () => {
    const empty = await upload(driver1, new Uint8Array(), { sizeBytes: 1 });
    expect(await register(driver1, empty.slot!.slotId)).toMatchObject({
      ok: false,
    });
    const whole = jpeg({ exif: tiff({ le: true }) });
    const cut = await upload(driver1, whole.subarray(0, whole.length - 8));
    expect(await register(driver1, cut.slot!.slotId)).toMatchObject({
      ok: false,
      code: "INVALID_IMAGE",
    });
  });

  it("DEC-29 flag off: stored as uploaded, recorded as not stripped", async () => {
    const original = jpeg({ exif: tiff({ le: true }) });
    const off: EvidenceConfig = { ...config, stripExifGps: false };
    const up = await upload(driver1, original, {}, { cfg: off });
    const reg = await register(driver1, up.slot!.slotId, off);
    expect(reg.ok).toBe(true);
    const { data: row } = await sa
      .from("evidence_files")
      .select("sha256, exif_gps_stripped")
      .eq("object_path", up.slot!.objectPath)
      .single();
    expect(row).toEqual({ sha256: sha(original), exif_gps_stripped: false });
  });
});

describe("tampering and permissions on upload", () => {
  it("a client cannot get a signed upload URL for a path of its own choosing, nor reuse a token for another path", async () => {
    const { error } = await driver1.storage
      .from("evidence")
      .createSignedUploadUrl(
        `${w.companyId}/${w.branchId}/odometer/${randomUUID()}.jpg`,
      );
    expect(error).toBeTruthy();
    const a = await upload(driver1, jpeg({}));
    const other = `${w.companyId}/${w.branchId}/odometer/${randomUUID()}.jpg`;
    const forged = await driver1.storage
      .from("evidence")
      .uploadToSignedUrl(
        other,
        a.slot!.token!,
        new Blob([jpeg({}) as BlobPart], { type: "image/jpeg" }),
      );
    expect(forged.error).toBeTruthy();
  });

  it("another user cannot register or reuse someone else's slot", async () => {
    const a = await upload(driver1, jpeg({}));
    expect(await register(driver2, a.slot!.slotId)).toMatchObject({
      ok: false,
      code: "NOT_FOUND",
    });
    // driver2 asking with driver1's submission id gets their OWN slot, not driver1's
    const mine = await requestUploadSlot({ db: driver2, config }, a.input);
    expect(mine.ok && mine.slot.slotId).not.toBe(a.slot!.slotId);
  });

  it("a registered object's path cannot be re-opened for upload", async () => {
    const a = await upload(driver1, jpeg({}));
    expect((await register(driver1, a.slot!.slotId)).ok).toBe(true);
    const { error } = await driver1.storage
      .from("evidence")
      .createSignedUploadUrl(a.slot!.objectPath);
    expect(error).toBeTruthy();
  });

  it("only roles with the purpose's permission, in their scope, can upload", async () => {
    const base = {
      captureSource: "file_upload",
      mimeType: "image/jpeg",
      sizeBytes: 1000,
    };
    const ask = (db: Db, over: Record<string, unknown>) =>
      requestUploadSlot(
        { db, config },
        { ...base, clientSubmissionId: randomUUID(), ...over },
      );
    expect(
      await ask(driver1, { purpose: "odometer", branchId: w.branchId }),
    ).toMatchObject({ ok: true });
    expect(
      await ask(driver1, { purpose: "odometer", branchId: w.otherBranchId }),
    ).toMatchObject({ ok: false, code: "FORBIDDEN" }); // other branch
    expect(
      await ask(driver1, { purpose: "licence", branchId: w.branchId }),
    ).toMatchObject({ ok: false, code: "FORBIDDEN" }); // no driver.manage
    expect(
      await ask(driver1, { purpose: "odometer", branchId: null }),
    ).toMatchObject({ ok: false, code: "FORBIDDEN" }); // company-level needs a company-wide grant
    expect(
      await ask(supB2, { purpose: "odometer", branchId: w.branchId }),
    ).toMatchObject({ ok: false, code: "FORBIDDEN" }); // supervisor of B2
    expect(
      await ask(sysadmin, { purpose: "odometer", branchId: w.branchId }),
    ).toMatchObject({ ok: false, code: "FORBIDDEN" }); // system admin: no evidence
    expect(
      await ask(fleetOther, {
        purpose: "service_record",
        branchId: w.branchId,
      }),
    ).toMatchObject({ ok: false, code: "FORBIDDEN" }); // other company
    expect(
      await ask(fleet, { purpose: "service_record", branchId: w.branchId }),
    ).toMatchObject({ ok: true });
  });

  it("clients cannot register evidence or write evidence tables directly", async () => {
    const a = await upload(driver1, jpeg({}));
    const forged = await driver1.rpc("register_evidence_file", {
      p_slot_id: a.slot!.slotId,
      p_user_id: ids.d1,
      p_sha256: "a".repeat(64),
      p_mime_type: "image/jpeg",
      p_size_bytes: 10,
      p_width: 1,
      p_height: 1,
      p_exif_gps_stripped: true,
    });
    expect(forged.error).toBeTruthy();
    for (const db of [driver1, fleet]) {
      const ins = await db.from("evidence_files").insert({
        company_id: w.companyId,
        bucket: "evidence",
        object_path: "forged",
        sha256: "a".repeat(64),
        mime_type: "image/jpeg",
        size_bytes: 1,
        capture_source: "gallery",
        exif_gps_stripped: true,
        uploaded_by: ids.d1,
        purpose: "odometer",
      });
      expect(ins.error).toBeTruthy();
      expect(
        (
          await db.from("evidence_access_log").insert({
            company_id: w.companyId,
            evidence_file_id: randomUUID(),
            accessed_by: ids.d1,
            access_type: "download",
          })
        ).error,
      ).toBeTruthy();
    }
  });
});

describe("signed read URLs: permission, short life, access log", () => {
  let fileId: string;
  let path: string;
  let body: Uint8Array;
  beforeAll(async () => {
    body = jpeg({});
    const up = await upload(driver1, body);
    const reg = await register(driver1, up.slot!.slotId);
    if (!reg.ok) throw new Error(reg.message);
    fileId = reg.evidence.evidenceFileId;
    path = up.slot!.objectPath;
  });

  it("an authorised user gets a working short-lived URL and every issue is logged", async () => {
    const before = await logCount(fileId);
    const r = await readUrl(driver1, fileId, {
      purpose: "inspection_review",
      relatedEntityType: "inspection",
      relatedEntityId: randomUUID(),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const res = await fetch(r.url);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(
      await storedBytes(path),
    );
    // lifetime comes from config (minutes) — check the token's exp
    const token = new URL(r.url).searchParams.get("token")!;
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1]!, "base64url").toString(),
    );
    const ttl = payload.exp - Math.floor(Date.now() / 1000);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(config.signedUrlMinutes * 60 + 5);
    expect(await logCount(fileId)).toBe(before + 1);

    expect((await readUrl(supB1, fileId)).ok).toBe(true); // supervisor of the branch
    expect((await readUrl(fleet, fileId)).ok).toBe(true); // fleet admin (all)
    expect(await logCount(fileId)).toBe(before + 3); // one log row per issue
    const { data: logs } = await sa
      .from("evidence_access_log")
      .select(
        "accessed_by, branch_id, company_id, access_type, purpose, related_entity_type",
      )
      .eq("evidence_file_id", fileId)
      .eq("accessed_by", ids.d1)
      .eq("purpose", "inspection_review");
    expect(logs).toEqual([
      {
        accessed_by: ids.d1,
        branch_id: w.branchId,
        company_id: w.companyId,
        access_type: "signed_url_issued",
        purpose: "inspection_review",
        related_entity_type: "inspection",
      },
    ]);
  });

  it("cross-branch, cross-company, other drivers and system admin are denied — and nothing is logged", async () => {
    const before = await logCount(fileId);
    for (const db of [driver2, supB2, fleetOther, sysadmin]) {
      expect(await readUrl(db, fileId)).toMatchObject({
        ok: false,
        code: "FORBIDDEN",
      });
    }
    expect(await logCount(fileId)).toBe(before);
    // direct storage reads are denied by the same policy
    for (const db of [driver2, supB2, fleetOther, sysadmin]) {
      expect(
        (await db.storage.from("evidence").download(path)).error,
      ).toBeTruthy();
      expect(
        (await db.storage.from("evidence").createSignedUrl(path, 60)).error,
      ).toBeTruthy();
    }
    // and the rows are invisible
    for (const db of [driver2, supB2, fleetOther, sysadmin]) {
      expect(
        (await db.from("evidence_files").select("id").eq("id", fileId)).data,
      ).toEqual([]);
    }
    // owner & branch staff can read the row
    for (const db of [driver1, supB1, fleet]) {
      expect(
        (await db.from("evidence_files").select("id").eq("id", fileId)).data,
      ).toEqual([{ id: fileId }]);
    }
  });

  it("direct Storage access needs a fresh, logged grant of the caller's own — evidence.view alone is not enough", async () => {
    const up = await upload(driver1, jpeg({}));
    const reg = await register(driver1, up.slot!.slotId);
    if (!reg.ok) throw new Error(reg.message);
    const id = reg.evidence.evidenceFileId;
    const p = up.slot!.objectPath;
    const direct = async (db: Db) => ({
      download: (await db.storage.from("evidence").download(p)).error,
      sign: (await db.storage.from("evidence").createSignedUrl(p, 60)).error,
      // the folder also holds other files this user was granted earlier: look for THIS file by name
      listed: (
        (
          await db.storage
            .from("evidence")
            .list(p.split("/").slice(0, -1).join("/"))
        ).data ?? []
      ).some((o) => o.name === p.split("/").pop()),
    });

    // 1. everyone who may VIEW it (owner, branch supervisor, fleet admin) is refused without a grant
    for (const db of [driver1, supB1, fleet]) {
      const r = await direct(db);
      expect(r.download).toBeTruthy();
      expect(r.sign).toBeTruthy();
      expect(r.listed).toBe(false);
    }
    expect(await logCount(id)).toBe(0); // and nothing was logged, nothing was served

    // 2. a grant is a logged issue: after it, only the grantee can read/sign directly
    expect((await readUrl(supB1, id)).ok).toBe(true);
    expect(await logCount(id)).toBe(1);
    const granted = await direct(supB1);
    expect(granted.download).toBeNull();
    expect(granted.sign).toBeNull();
    expect(granted.listed).toBe(true);
    // 3. someone else's log row grants nothing
    for (const db of [driver1, fleet])
      expect((await direct(db)).download).toBeTruthy();
    // and the going-through-the-front-door path is the only way in: still no extra log rows from direct reads
    expect(await logCount(id)).toBe(1);

    // 4. the window closes: a 2-second grant works now and not a little later
    const short = await fleet.rpc("issue_evidence_access", {
      p_evidence_file_id: id,
      p_purpose: "window-test",
      p_ttl_seconds: 2,
    });
    expect(short.error).toBeNull();
    expect((await direct(fleet)).download).toBeNull();
    await sleep(3500);
    expect((await direct(fleet)).download).toBeTruthy();
    expect((await direct(fleet)).sign).toBeTruthy();
    // supB1's 5-minute grant is unaffected
    expect((await direct(supB1)).download).toBeNull();
    // refused users still cannot get a grant (can_view_evidence still applies)
    for (const db of [driver2, supB2, fleetOther, sysadmin]) {
      expect(
        (await db.rpc("issue_evidence_access", { p_evidence_file_id: id }))
          .error,
      ).toBeTruthy();
    }
  }, 30_000);

  it("the access log is readable only with audit.view in scope", async () => {
    expect(
      (
        (
          await sysadmin
            .from("evidence_access_log")
            .select("id")
            .eq("evidence_file_id", fileId)
        ).data ?? []
      ).length,
    ).toBeGreaterThan(0);
    for (const db of [driver1, supB1, fleetOther]) {
      expect(
        (
          await db
            .from("evidence_access_log")
            .select("id")
            .eq("evidence_file_id", fileId)
        ).data,
      ).toEqual([]);
    }
  });

  it("evidence rows and the access log are immutable — for users and for the service role", async () => {
    for (const db of [supB1, fleet, sa]) {
      const upd = await db
        .from("evidence_files")
        .update({ sha256: "0".repeat(64) })
        .eq("id", fileId)
        .select();
      expect(upd.error || (upd.data ?? []).length === 0).toBeTruthy();
      const del = await db
        .from("evidence_files")
        .delete()
        .eq("id", fileId)
        .select();
      expect(del.error || (del.data ?? []).length === 0).toBeTruthy();
      const updLog = await db
        .from("evidence_access_log")
        .update({ purpose: "x" })
        .eq("evidence_file_id", fileId)
        .select();
      expect(updLog.error || (updLog.data ?? []).length === 0).toBeTruthy();
    }
    const { data: row } = await sa
      .from("evidence_files")
      .select("sha256")
      .eq("id", fileId)
      .single();
    expect(row!.sha256).toBe(sha(await storedBytes(path)));
    // clients cannot replace or delete the stored object either
    const before = await storedBytes(path);
    expect(
      (await driver1.storage.from("evidence").remove([path])).data ?? [],
    ).toEqual([]);
    expect(await storedBytes(path)).toEqual(before);
  });
});

describe("cleanup of unregistered uploads (background job, AD-01)", () => {
  it("removes expired unregistered uploads, never registered evidence, and is idempotent", async () => {
    // slots with the shortest possible lifetime (1 minute) so the real handler can be exercised
    const short: EvidenceConfig = { ...config, uploadSlotMinutes: 1 };
    const orphan = await upload(driver1, jpeg({}), {}, { cfg: short });
    const kept = await upload(driver1, jpeg({}), {}, { cfg: short });
    expect((await register(driver1, kept.slot!.slotId, short)).ok).toBe(true);
    const gone = async (p: string) =>
      (await sa.storage.from("evidence").info(p)).error !== null;
    expect(await gone(orphan.slot!.objectPath)).toBe(false);

    const wait = Date.parse(orphan.slot!.expiresAt) - Date.now() + 1500;
    if (wait > 0) await sleep(wait);

    const jobId = await enqueueEvidenceCleanup(sa, { force: true });
    expect(
      await enqueueEvidenceCleanup(sa, {
        now: new Date("2026-11-17T10:00:00Z"),
      }),
    ).toBe(
      await enqueueEvidenceCleanup(sa, {
        now: new Date("2026-11-17T10:30:00Z"),
      }),
    ); // same hour = same job
    const handlers = {
      [EVIDENCE_CLEANUP_JOB]: evidenceCleanupHandler(sa, {
        ...config,
        cleanupGraceMinutes: 0,
      }),
    };
    const outcomes = await runDueJobs(sa, handlers, "int-test");
    expect(outcomes.length).toBeGreaterThanOrEqual(1);
    expect(outcomes.every((o) => o.ran && o.status === "succeeded")).toBe(true);

    expect(await gone(orphan.slot!.objectPath)).toBe(true); // unregistered upload removed
    expect(await gone(kept.slot!.objectPath)).toBe(false); // registered evidence untouched
    const { data: orphanSlot } = await sa
      .from("evidence_upload_slots")
      .select("status, object_removed_at")
      .eq("id", orphan.slot!.slotId)
      .single();
    expect(orphanSlot!.status).toBe("abandoned");
    expect(orphanSlot!.object_removed_at).not.toBeNull();
    const { count } = await sa
      .from("evidence_files")
      .select("id", { count: "exact", head: true })
      .eq("object_path", kept.slot!.objectPath);
    expect(count).toBe(1);
    const { data: job } = await sa
      .from("background_jobs")
      .select("status, attempts")
      .eq("id", jobId)
      .single();
    expect(job).toMatchObject({ status: "succeeded", attempts: 1 });

    // idempotent: a second run finds nothing to remove
    await enqueueEvidenceCleanup(sa, { force: true });
    const again = await runDueJobs(sa, handlers, "int-test");
    expect(again.every((o) => o.ran && o.status === "succeeded")).toBe(true);
    expect(await gone(kept.slot!.objectPath)).toBe(false);

    // the abandoned submission can be retried: same key re-opens the slot for a fresh upload
    const retry = await requestUploadSlot(
      { db: driver1, config },
      orphan.input,
    );
    expect(retry.ok && retry.slot.alreadyUploaded).toBe(false);
    expect(retry.ok && retry.slot.uploadUrl).toBeTruthy();
  }, 150_000);
});
