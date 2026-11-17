import { describe, expect, it } from "vitest";
import { called, fakeClient } from "@/test/fake-supabase";
import { cleanupUnregisteredUploads } from "./cleanup";

const OPTS = { graceMinutes: 180, batchSize: 50 };
const slot = (n: number) => ({
  id: `00000000-0000-4000-8000-00000000000${n}`,
  bucket: "evidence",
  object_path: `co/b/odometer/${n}.jpg`,
});

describe("cleanupUnregisteredUploads (job handler)", () => {
  it("removes the claimed objects, then records the removal", async () => {
    const f = fakeClient({
      objects: {
        "co/b/odometer/1.jpg": new Uint8Array([1]),
        "co/b/odometer/2.jpg": new Uint8Array([2]),
      },
      rpc: {
        claim_abandoned_evidence_slots: () => ({ data: [slot(1), slot(2)] }),
        mark_evidence_slots_object_removed: () => ({ data: 2 }),
      },
    });
    expect(await cleanupUnregisteredUploads(f.client, OPTS)).toEqual({
      claimed: 2,
      objectsRemoved: 2,
      slotsMarked: 2,
      skippedRegistered: 0,
    });
    expect(
      called(f.calls, "rpc:claim_abandoned_evidence_slots")[0]!.args[0],
    ).toEqual({ p_grace_minutes: 180, p_limit: 50 });
    expect(called(f.calls, "remove")[0]!.args[1]).toEqual([
      "co/b/odometer/1.jpg",
      "co/b/odometer/2.jpg",
    ]);
    expect(Object.keys(f.objects)).toEqual([]);
  });

  it("never deletes registered evidence, even if the database offered it", async () => {
    const f = fakeClient({
      objects: {
        "co/b/odometer/1.jpg": new Uint8Array([1]),
        "co/b/odometer/2.jpg": new Uint8Array([2]),
      },
      rpc: {
        claim_abandoned_evidence_slots: () => ({ data: [slot(1), slot(2)] }),
        "from:evidence_files": () => ({
          data: [{ bucket: "evidence", object_path: "co/b/odometer/2.jpg" }],
        }),
        mark_evidence_slots_object_removed: () => ({ data: 1 }),
      },
    });
    const r = await cleanupUnregisteredUploads(f.client, OPTS);
    expect(r).toMatchObject({
      claimed: 2,
      objectsRemoved: 1,
      skippedRegistered: 1,
    });
    expect(called(f.calls, "remove")[0]!.args[1]).toEqual([
      "co/b/odometer/1.jpg",
    ]);
    expect(f.objects["co/b/odometer/2.jpg"]).toBeDefined(); // still there
  });

  it("nothing to do: no storage calls", async () => {
    const f = fakeClient({
      rpc: { claim_abandoned_evidence_slots: () => ({ data: [] }) },
    });
    expect(await cleanupUnregisteredUploads(f.client, OPTS)).toEqual({
      claimed: 0,
      objectsRemoved: 0,
      slotsMarked: 0,
      skippedRegistered: 0,
    });
    expect(called(f.calls, "remove")).toHaveLength(0);
  });

  it("if removal fails it throws and records nothing, so the next run retries the same slots", async () => {
    const f = fakeClient({
      removeError: { message: "storage down" },
      rpc: {
        claim_abandoned_evidence_slots: () => ({ data: [slot(1)] }),
        mark_evidence_slots_object_removed: () => ({ data: 1 }),
      },
    });
    await expect(cleanupUnregisteredUploads(f.client, OPTS)).rejects.toThrow(
      /remove failed/,
    );
    expect(
      called(f.calls, "rpc:mark_evidence_slots_object_removed"),
    ).toHaveLength(0);
  });
});
