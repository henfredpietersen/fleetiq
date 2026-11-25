import { describe, expect, it } from "vitest";
import { classifyHttp, type Outcome, type PutOutcome } from "./classify";
import { SyncRunner, type SyncOp, type Transport } from "./runner";
import { MemoryStore, type NewItem } from "./store";
import type { PhotoMeta, QueueItem } from "./types";

const P = "profile-1";
const A = "alloc-1";
const SCOPE = `${A}:pre_shift`;
const ok = (data: Record<string, unknown> = {}): Outcome => ({
  kind: "ok",
  data: { ok: true, ...data },
});
const retry = (): Outcome => ({
  kind: "retry",
  message: "No connection to the server.",
});

type Call = { op: SyncOp; body: Record<string, unknown> };
function fakeTransport(handler: (c: Call, n: number) => Outcome | undefined) {
  const calls: Call[] = [];
  const puts: string[] = [];
  let putResults: PutOutcome[] = [];
  const t: Transport = {
    async call(op, body) {
      calls.push({ op, body });
      const r = handler({ op, body }, calls.filter((c) => c.op === op).length);
      if (r) return r;
      switch (op) {
        case "begin":
          return ok({ inspectionId: "insp-1" });
        case "slot":
          return ok({
            slot: {
              slotId: "slot-1",
              uploadUrl: "https://up/" + calls.length,
              alreadyUploaded: false,
              alreadyRegistered: false,
              evidenceFileId: null,
            },
          });
        case "register":
          return ok({ evidence: { evidenceFileId: "file-1" } });
        case "report_conflict":
          return ok({ conflictId: "conf-1" });
        case "conflict_status":
          return ok({ conflicts: [] });
        default:
          return ok();
      }
    },
    async put(url) {
      puts.push(url);
      return putResults.shift() ?? "ok";
    },
  };
  return { t, calls, puts, putResults: (r: PutOutcome[]) => (putResults = r) };
}

const meta = (id: string): PhotoMeta => ({
  blobId: id,
  size: 3,
  width: 10,
  height: 10,
  capturedAt: "2026-11-25T08:00:00.000Z",
  location: null,
  capturedOffline: true,
});
let n = 0;
const base = (
  over: Partial<NewItem> & Pick<NewItem, "kind" | "payload">,
): NewItem => ({
  id: `item-${++n}`,
  profileId: P,
  scope: SCOPE,
  allocationId: A,
  stage: "pre_shift",
  csid: `csid-${n}`,
  deviceTime: "2026-11-25T08:00:00.000Z",
  createdAt: 0,
  capturedOffline: true,
  attempts: 0,
  nextAttemptAt: 0,
  ...over,
});
async function seed(
  store: MemoryStore,
  which: ("begin" | "save" | "photo" | "submit")[],
) {
  const out: QueueItem[] = [];
  for (const k of which) {
    if (k === "begin")
      out.push(
        await store.add(base({ kind: "begin", payload: { kind: "begin" } })),
      );
    if (k === "save")
      out.push(
        await store.add(
          base({
            kind: "save",
            payload: {
              kind: "save",
              responses: [{ templateItemId: "t1", value: "ok" }],
              vehicleConfirmed: true,
            },
          }),
        ),
      );
    if (k === "photo")
      out.push(
        await store.add(
          base({
            kind: "photo",
            payload: {
              kind: "photo",
              target: { kind: "odometer" },
              photo: meta("blob-1"),
              attachCsid: "attach-csid",
            },
          }),
          [{ id: "blob-1", blob: new Blob(["abc"]) }],
        ),
      );
    if (k === "submit")
      out.push(
        await store.add(base({ kind: "submit", payload: { kind: "submit" } })),
      );
  }
  return out;
}
const runner = (store: MemoryStore, t: Transport, now = () => 1_000) =>
  new SyncRunner(P, {
    store,
    transport: t,
    now,
    deviceKey: async () => "dev-key",
  });

describe("sync runner", () => {
  it("sends one inspection's items strictly in order and clears each only after the server confirmed", async () => {
    const store = new MemoryStore();
    await seed(store, ["begin", "save", "photo", "submit"]);
    const f = fakeTransport(() => undefined);
    const r = await runner(store, f.t).drain();
    expect(r).toEqual({ sent: 4, auth: false });
    expect(f.calls.map((c) => c.op)).toEqual([
      "begin",
      "save",
      "slot",
      "register",
      "attach_odometer",
      "submit",
    ]);
    expect(await store.list(P)).toHaveLength(0);
    expect(store.blobCount(P)).toBe(0); // the blob goes only after attach confirmed
    // later items use the inspection the begin returned
    expect(f.calls[1]!.body.inspectionId).toBe("insp-1");
    expect(f.calls[5]!.body).toMatchObject({
      inspectionId: "insp-1",
      capturedOffline: true,
    });
  });

  it("a retry waits (backoff), keeps the item and sends the SAME client_submission_id; later items do not jump ahead", async () => {
    const store = new MemoryStore();
    const [begin] = await seed(store, ["begin", "save"]);
    let failures = 1;
    const f = fakeTransport((c) =>
      c.op === "begin" && failures-- > 0 ? retry() : undefined,
    );
    let now = 1_000;
    const rn = runner(store, f.t, () => now);
    await rn.drain();
    let items = await store.list(P);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      attempts: 1,
      nextAttemptAt: 1_000 + 2_000,
      lastError: "No connection to the server.",
    });
    expect(f.calls.map((c) => c.op)).toEqual(["begin"]); // the save did not go first
    await rn.drain(); // still inside the backoff
    expect(f.calls).toHaveLength(1);
    now = 3_001;
    await rn.drain();
    expect(f.calls.map((c) => c.op)).toEqual(["begin", "begin", "save"]);
    expect(f.calls[1]!.body.clientSubmissionId).toBe(
      f.calls[0]!.body.clientSubmissionId,
    );
    expect(f.calls[0]!.body.clientSubmissionId).toBe(begin!.csid);
    items = await store.list(P);
    expect(items).toHaveLength(0);
  });

  it("backoff doubles with every failed attempt", async () => {
    const store = new MemoryStore();
    await seed(store, ["begin"]);
    const f = fakeTransport(() => retry());
    let now = 0;
    const rn = runner(store, f.t, () => now);
    const waits: number[] = [];
    for (let i = 0; i < 4; i++) {
      await rn.drain();
      const it = (await store.list(P))[0]!;
      waits.push(it.nextAttemptAt - now);
      now = it.nextAttemptAt;
    }
    expect(waits).toEqual([2_000, 4_000, 8_000, 16_000]);
  });

  it("a replay answer counts as success (the server returns the same id)", async () => {
    const store = new MemoryStore();
    await seed(store, ["begin", "submit"]);
    const f = fakeTransport((c) =>
      c.op === "begin"
        ? ok({ inspectionId: "insp-1", replayed: true })
        : undefined,
    );
    expect((await runner(store, f.t).drain()).sent).toBe(2);
  });

  it("a server refusal is a conflict: that inspection stops, everything stays, the message is kept as is and reported", async () => {
    const store = new MemoryStore();
    const other = "alloc-2:pre_shift";
    await seed(store, ["begin", "save", "submit"]);
    await store.add(
      base({
        kind: "begin",
        scope: other,
        allocationId: "alloc-2",
        payload: { kind: "begin" },
      }),
    );
    const f = fakeTransport((c) =>
      c.op === "begin" && c.body.allocationId === A
        ? classifyHttp(409, {
            ok: false,
            code: "55000",
            message: "This allocation was cancelled by your supervisor.",
          })
        : undefined,
    );
    await runner(store, f.t).drain();
    const items = await store.list(P);
    expect(items.filter((i) => i.scope === SCOPE)).toHaveLength(3); // nothing dropped or rewritten
    expect(items.filter((i) => i.scope === other)).toHaveLength(0); // the other inspection still went
    const [s] = await store.scopes(P);
    expect(s).toMatchObject({
      status: "conflict",
      code: "55000",
      message: "This allocation was cancelled by your supervisor.",
      reported: true,
      conflictId: "conf-1",
    });
    const rep = f.calls.find((c) => c.op === "report_conflict")!;
    expect(rep.body).toMatchObject({
      allocationId: A,
      functionName: "begin_inspection",
      refusalCode: "55000",
      refusalMessage: "This allocation was cancelled by your supervisor.",
      clientSubmissionId: s!.conflictCsid,
    });
    expect(JSON.stringify(rep.body)).not.toContain("blob"); // the refusal only: no photos or answers
    // a second drain never sends the stopped inspection again
    const before = f.calls.length;
    await runner(store, f.t).drain();
    expect(f.calls.filter((c) => c.op === "begin")).toHaveLength(2);
    expect(f.calls.length).toBeGreaterThan(before - 1);
  });

  it("an unreported conflict is reported again on the next run; a supervisor's resolution is noticed", async () => {
    const store = new MemoryStore();
    await seed(store, ["begin"]);
    let reportOk = false;
    let resolved = false;
    const f = fakeTransport((c) => {
      if (c.op === "begin")
        return classifyHttp(403, {
          ok: false,
          code: "42501",
          message: "Not allowed.",
        });
      if (c.op === "report_conflict" && !reportOk) return retry();
      if (c.op === "conflict_status")
        return ok({
          conflicts: [
            {
              clientSubmissionId: (c.body.clientSubmissionIds as string[])[0],
              resolved,
              note: "Handled on paper",
              resolvedAt: "2026-11-25T10:00:00Z",
            },
          ],
        });
      return undefined;
    });
    const rn = runner(store, f.t);
    await rn.drain();
    expect((await store.scopes(P))[0]!.reported).toBe(false);
    reportOk = true;
    await rn.drain();
    expect((await store.scopes(P))[0]).toMatchObject({
      reported: true,
      status: "conflict",
    });
    resolved = true;
    await rn.drain();
    expect((await store.scopes(P))[0]).toMatchObject({
      status: "resolved",
      resolutionNote: "Handled on paper",
    });
    expect(await store.list(P)).toHaveLength(1); // still on the phone until the driver removes it
  });

  it("401 pauses the queue (nothing is sent under another session) and keeps everything", async () => {
    const store = new MemoryStore();
    await seed(store, ["begin", "save"]);
    const f = fakeTransport(() => ({
      kind: "auth",
      message: "Sign in again.",
    }));
    const r = await runner(store, f.t).drain();
    expect(r.auth).toBe(true);
    expect(await store.list(P)).toHaveLength(2);
    expect(f.calls).toHaveLength(1);
  });

  it("a photo: slot -> upload -> register -> attach, with the slot requested right before the upload and the blob kept until attach", async () => {
    const store = new MemoryStore();
    await seed(store, ["begin", "photo"]);
    let attachFails = true;
    const f = fakeTransport((c) =>
      c.op === "attach_odometer" && attachFails ? retry() : undefined,
    );
    const rn = runner(store, f.t, () => 1_000);
    await rn.drain();
    expect(f.calls.map((c) => c.op)).toEqual([
      "begin",
      "slot",
      "register",
      "attach_odometer",
    ]);
    expect(store.blobCount(P)).toBe(1); // attach did not confirm: the blob stays
    const [pending] = await store.list(P);
    expect(pending!.payload).toMatchObject({ evidenceFileId: "file-1" }); // upload progress is remembered
    attachFails = false;
    const r2 = runner(store, f.t, () => 10_000);
    await r2.drain();
    // the retry skipped slot/upload/register and re-sent the attach with the same attach csid
    expect(f.calls.map((c) => c.op)).toEqual([
      "begin",
      "slot",
      "register",
      "attach_odometer",
      "attach_odometer",
    ]);
    expect(f.calls[4]!.body.clientSubmissionId).toBe("attach-csid");
    expect(f.puts).toHaveLength(1);
    expect(store.blobCount(P)).toBe(0);
  });

  it("a slot that expired mid-upload is requested again with the SAME client_submission_id", async () => {
    const store = new MemoryStore();
    await seed(store, ["begin", "photo"]);
    const f = fakeTransport(() => undefined);
    f.putResults(["expired", "ok"]);
    await runner(store, f.t).drain();
    const slots = f.calls.filter((c) => c.op === "slot");
    expect(slots).toHaveLength(2);
    expect(slots[1]!.body.clientSubmissionId).toBe(
      slots[0]!.body.clientSubmissionId,
    );
    expect(f.puts).toHaveLength(2);
    expect(await store.list(P)).toHaveLength(0);
  });

  it("an expired slot reported by register is requested again; a slot that is already registered is not uploaded twice", async () => {
    const store = new MemoryStore();
    await seed(store, ["begin", "photo"]);
    let regs = 0;
    const f = fakeTransport((c) =>
      c.op === "register" && regs++ === 0
        ? classifyHttp(410, {
            ok: false,
            code: "SLOT_EXPIRED",
            message: "The upload window has expired. Start again.",
          })
        : undefined,
    );
    await runner(store, f.t).drain();
    expect(f.calls.filter((c) => c.op === "slot")).toHaveLength(2);

    const store2 = new MemoryStore();
    await seed(store2, ["begin", "photo"]);
    const g = fakeTransport((c) =>
      c.op === "slot"
        ? ok({
            slot: {
              slotId: "s",
              uploadUrl: null,
              alreadyUploaded: true,
              alreadyRegistered: true,
              evidenceFileId: "file-9",
            },
          })
        : undefined,
    );
    await runner(store2, g.t).drain();
    expect(g.puts).toHaveLength(0);
    expect(g.calls.some((c) => c.op === "register")).toBe(false);
    expect(
      g.calls.find((c) => c.op === "attach_odometer")!.body.evidenceFileId,
    ).toBe("file-9");
  });

  it("a slot that keeps expiring is retried later, never dropped", async () => {
    const store = new MemoryStore();
    await seed(store, ["begin", "photo"]);
    const f = fakeTransport(() => undefined);
    f.putResults(["expired", "expired"]);
    await runner(store, f.t).drain();
    const [item] = await store.list(P);
    expect(item!.attempts).toBe(1);
    expect(store.blobCount(P)).toBe(1);
  });

  it("per-profile isolation: another profile's runner neither sees nor sends these items", async () => {
    const store = new MemoryStore();
    await seed(store, ["begin", "save"]);
    const f = fakeTransport(() => undefined);
    const other = new SyncRunner("profile-2", {
      store,
      transport: f.t,
      now: () => 1_000,
      deviceKey: async () => null,
    });
    expect(await other.drain()).toEqual({ sent: 0, auth: false });
    expect(f.calls).toHaveLength(0);
    expect(await store.list("profile-2")).toHaveLength(0);
    expect(await store.list(P)).toHaveLength(2);
    // and the owner can still send them after "signing back in"
    expect((await runner(store, f.t).drain()).sent).toBe(2);
  });

  it("a damage report registers every photo (own slot csid each), then reports with their ids", async () => {
    const store = new MemoryStore();
    await seed(store, ["begin"]);
    await store.add(
      base({
        kind: "report_damage",
        payload: {
          kind: "report_damage",
          zone: "front_bumper",
          severity: "minor",
          description: "Scratch",
          photos: [
            { photo: meta("d1"), slotCsid: "slot-a" },
            { photo: meta("d2"), slotCsid: "slot-b" },
          ],
        },
      }),
      [
        { id: "d1", blob: new Blob(["1"]) },
        { id: "d2", blob: new Blob(["2"]) },
      ],
    );
    let reg = 0;
    const f = fakeTransport((c) =>
      c.op === "register"
        ? ok({ evidence: { evidenceFileId: `file-${++reg}` } })
        : undefined,
    );
    await runner(store, f.t).drain();
    const slots = f.calls.filter((c) => c.op === "slot");
    expect(slots.map((s) => s.body.clientSubmissionId)).toEqual([
      "slot-a",
      "slot-b",
    ]);
    expect(slots[0]!.body.kind).toBe("damage");
    expect(f.calls.at(-1)!.op).toBe("report_damage");
    expect(f.calls.at(-1)!.body.evidenceFileIds).toEqual(["file-1", "file-2"]);
    expect(store.blobCount(P)).toBe(0);
  });

  it("nothing happens while the server is unreachable and nothing is lost: items keep their order and ids", async () => {
    const store = new MemoryStore();
    const items = await seed(store, ["begin", "save", "submit"]);
    const f = fakeTransport(() => retry());
    await runner(store, f.t).drain();
    const after = await store.list(P);
    expect(after.map((i) => i.id)).toEqual(items.map((i) => i.id));
    expect(after.map((i) => i.csid)).toEqual(items.map((i) => i.csid));
  });
});
