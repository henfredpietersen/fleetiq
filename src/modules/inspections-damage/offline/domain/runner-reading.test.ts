import { describe, expect, it } from "vitest";
import { classifyHttp, type Outcome } from "./classify";
import { SyncRunner, type SyncOp, type Transport } from "./runner";
import { MemoryStore, type NewItem } from "./store";
import { applyQueue } from "./overlay";
import { describeItems } from "./status";
import type { MyInspection } from "../../domain/inspection-types";

// 5A (DEC-05, DEC-06 / DEC-43): the driver's typed reading is one more queue item. Same ordering, retry and conflict rules as every other
// inspection write; its own client_submission_id; no OCR anywhere in what the phone stores or sends.
const P = "profile-1";
const A = "alloc-1";
const SCOPE = `${A}:pre_shift`;
const ok = (data: Record<string, unknown> = {}): Outcome => ({
  kind: "ok",
  data: { ok: true, ...data },
});

type Call = { op: SyncOp; body: Record<string, unknown> };
function transport(handler: (c: Call) => Outcome | undefined) {
  const calls: Call[] = [];
  const t: Transport = {
    async call(op, body) {
      calls.push({ op, body });
      const r = handler({ op, body });
      if (r) return r;
      switch (op) {
        case "begin":
          return ok({ inspectionId: "insp-1" });
        case "slot":
          return ok({
            slot: {
              slotId: "s",
              uploadUrl: "https://up/1",
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
    async put() {
      return "ok";
    },
  };
  return { t, calls };
}
let n = 0;
const item = (
  over: Partial<NewItem> & Pick<NewItem, "kind" | "payload">,
): NewItem => ({
  id: `r-${++n}`,
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
async function seedFlow(store: MemoryStore) {
  await store.add(item({ kind: "begin", payload: { kind: "begin" } }));
  await store.add(
    item({
      kind: "photo",
      payload: {
        kind: "photo",
        target: { kind: "odometer" },
        photo: {
          blobId: "b1",
          size: 3,
          width: 1,
          height: 1,
          capturedAt: "2026-11-25T08:00:00.000Z",
          location: null,
          capturedOffline: true,
        },
        attachCsid: "attach-1",
      },
    }),
    [{ id: "b1", blob: new Blob(["abc"]) }],
  );
  const reading = await store.add(
    item({
      kind: "reading",
      csid: "reading-csid",
      payload: { kind: "reading", km: 123456 },
    }),
  );
  await store.add(item({ kind: "submit", payload: { kind: "submit" } }));
  return reading;
}
const runner = (store: MemoryStore, t: Transport, now = () => 1_000) =>
  new SyncRunner(P, { store, transport: t, now, deviceKey: async () => "k" });

describe("the reading queue item", () => {
  it("is sent after the odometer photo is attached and before the submit, with its own client_submission_id and the device context", async () => {
    const store = new MemoryStore();
    await seedFlow(store);
    const f = transport(() => undefined);
    const r = await runner(store, f.t).drain();
    expect(r).toEqual({ sent: 4, auth: false });
    expect(f.calls.map((c) => c.op)).toEqual([
      "begin",
      "slot",
      "register",
      "attach_odometer",
      "record_reading",
      "submit",
    ]);
    const rd = f.calls.find((c) => c.op === "record_reading")!;
    expect(rd.body).toEqual({
      inspectionId: "insp-1",
      readingKm: 123456,
      deviceTime: "2026-11-25T08:00:00.000Z",
      capturedOffline: true,
      clientSubmissionId: "reading-csid",
    });
    expect(await store.list(P)).toHaveLength(0);
  });

  it("a network failure waits (backoff) and retries with the SAME client_submission_id; the submit does not jump ahead", async () => {
    const store = new MemoryStore();
    await seedFlow(store);
    let failures = 1;
    const f = transport((c) =>
      c.op === "record_reading" && failures-- > 0
        ? { kind: "retry", message: "No connection to the server." }
        : undefined,
    );
    let now = 1_000;
    const rn = runner(store, f.t, () => now);
    await rn.drain();
    const left = await store.list(P);
    expect(left.map((i) => i.kind)).toEqual(["reading", "submit"]);
    expect(left[0]).toMatchObject({ attempts: 1, nextAttemptAt: 3_000 });
    expect(f.calls.some((c) => c.op === "submit")).toBe(false);
    now = 3_001;
    await rn.drain();
    const sends = f.calls.filter((c) => c.op === "record_reading");
    expect(sends).toHaveLength(2);
    expect(sends[1]!.body.clientSubmissionId).toBe(
      sends[0]!.body.clientSubmissionId,
    );
    expect(f.calls.at(-1)!.op).toBe("submit");
    expect(await store.list(P)).toHaveLength(0);
  });

  it("a refusal is a conflict like any other write: the scope stops, nothing is dropped, the server's message is kept and reported", async () => {
    const store = new MemoryStore();
    const reading = await seedFlow(store);
    const f = transport((c) =>
      c.op === "record_reading"
        ? classifyHttp(409, {
            ok: false,
            code: "IN006",
            message:
              "Take the odometer photo first, then enter the reading shown in it.",
          })
        : undefined,
    );
    await runner(store, f.t).drain();
    expect((await store.list(P)).map((i) => i.kind)).toEqual([
      "reading",
      "submit",
    ]);
    const [s] = await store.scopes(P);
    expect(s).toMatchObject({
      status: "conflict",
      itemKind: "reading",
      code: "IN006",
      message:
        "Take the odometer photo first, then enter the reading shown in it.",
      conflictCsid: reading.csid,
      reported: true,
    });
    expect(f.calls.find((c) => c.op === "report_conflict")!.body).toMatchObject(
      {
        functionName: "record_driver_reading",
        refusalCode: "IN006",
        clientSubmissionId: reading.csid,
      },
    );
    expect(f.calls.some((c) => c.op === "submit")).toBe(false);
  });

  it("classification: 5xx and timeouts retry, 401 pauses, 403 / 409 / 422 are refusals", () => {
    expect(classifyHttp(503, { ok: false }).kind).toBe("retry");
    expect(classifyHttp(401, { ok: false, message: "x" }).kind).toBe("auth");
    for (const s of [403, 404, 409, 410, 422])
      expect(
        classifyHttp(s, { ok: false, code: "22023", message: "no" }).kind,
      ).toBe("refused");
  });

  it("a replay answer (the server already has this reading) counts as success", async () => {
    const store = new MemoryStore();
    await seedFlow(store);
    const f = transport((c) =>
      c.op === "record_reading" ? ok({ replayed: true }) : undefined,
    );
    expect((await runner(store, f.t).drain()).sent).toBe(4);
  });

  it("DEC-05: nothing the phone stores or sends carries an OCR field", async () => {
    const store = new MemoryStore();
    await seedFlow(store);
    const f = transport(() => undefined);
    await runner(store, f.t).drain();
    expect(JSON.stringify(f.calls)).not.toMatch(/ocr/i);
    const server: MyInspection = {
      allocation_status: "pre_inspection_pending",
      stage: "pre_shift",
      vehicle: {
        fleet_number: "F1",
        registration: "R1",
        make: "M",
        model: "X",
      },
      inspection: null,
      items: [],
      photo_slots: [],
      odometer_photo_present: false,
      reading: null,
      known_damage_reviewed: false,
      known_damage: [],
      new_damage: [],
    };
    const q = await store.add(
      item({ kind: "reading", payload: { kind: "reading", km: 777 } }),
    );
    const ov = applyQueue(server, [q], SCOPE);
    expect(ov.readingQueuedKm).toBe(777);
    expect(ov.data.reading).toEqual({
      driver_reading_km: 777,
      status: "entered",
    });
    expect(JSON.stringify(ov)).not.toMatch(/ocr/i);
    expect(describeItems([q])).toEqual(["your odometer reading"]);
  });
});
