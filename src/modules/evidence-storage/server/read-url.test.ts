import { describe, expect, it } from "vitest";
import { DEFAULT_EVIDENCE_CONFIG } from "../domain/evidence-config";
import { called, fakeClient, names } from "@/test/fake-supabase";
import { issueSignedReadUrl } from "./read-url";

const FILE = "77777777-7777-4777-8777-777777777777";
const deps = (f: ReturnType<typeof fakeClient>) => ({
  db: f.client,
  config: { ...DEFAULT_EVIDENCE_CONFIG, signedUrlMinutes: 3 },
});

describe("issueSignedReadUrl", () => {
  it("checks + logs first (one DB call), then mints a SHORT-lived URL with the configured lifetime", async () => {
    const f = fakeClient({
      rpc: {
        issue_evidence_access: () => ({
          data: [{ bucket: "evidence", object_path: "co/b/odometer/o.jpg" }],
        }),
      },
    });
    const r = await issueSignedReadUrl(deps(f), {
      evidenceFileId: FILE,
      purpose: "inspection_review",
      relatedEntityType: "inspection",
    });
    expect(r).toMatchObject({ ok: true, expiresInSeconds: 180 });
    expect(called(f.calls, "createSignedUrl")[0]!.args).toEqual([
      "evidence",
      "co/b/odometer/o.jpg",
      180,
    ]);
    expect(names(f.calls)).toEqual([
      "rpc:issue_evidence_access",
      "createSignedUrl",
    ]); // log/permission BEFORE the URL
    expect(
      called(f.calls, "rpc:issue_evidence_access")[0]!.args[0],
    ).toMatchObject({
      p_evidence_file_id: FILE,
      p_purpose: "inspection_review",
      p_related_entity_type: "inspection",
    });
  });

  it("no permission / not in scope / not found: refused, no URL minted", async () => {
    const f = fakeClient({
      rpc: {
        issue_evidence_access: () => ({
          error: { code: "42501", message: "evidence not available" },
        }),
      },
    });
    expect(
      await issueSignedReadUrl(deps(f), { evidenceFileId: FILE }),
    ).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(called(f.calls, "createSignedUrl")).toHaveLength(0);
    const empty = fakeClient({
      rpc: { issue_evidence_access: () => ({ data: [] }) },
    });
    expect(
      await issueSignedReadUrl(deps(empty), { evidenceFileId: FILE }),
    ).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(called(empty.calls, "createSignedUrl")).toHaveLength(0);
  });

  it("rejects malformed ids before touching the database", async () => {
    const f = fakeClient();
    expect(
      await issueSignedReadUrl(deps(f), { evidenceFileId: "x" }),
    ).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(
      await issueSignedReadUrl(deps(f), {
        evidenceFileId: FILE,
        relatedEntityId: "nope",
      }),
    ).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(f.calls).toHaveLength(0);
  });

  it("a storage failure after the check is UNAVAILABLE and returns no URL", async () => {
    const f = fakeClient({
      rpc: {
        issue_evidence_access: () => ({
          data: [{ bucket: "evidence", object_path: "p" }],
        }),
      },
      signedUrl: { error: { message: "down" } },
    });
    expect(
      await issueSignedReadUrl(deps(f), { evidenceFileId: FILE }),
    ).toMatchObject({ ok: false, code: "UNAVAILABLE" });
  });
});
