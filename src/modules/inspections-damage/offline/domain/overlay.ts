// The inspection as the phone shows it: the last data from the server (live page or the 24-hour snapshot) with every item still
// waiting in the queue applied on top. The queue is the only record of unsent work, so a reload, a sign-out/sign-in or a dead
// connection always shows the same thing.
import { zoneLabel as damageZoneLabel } from "../../domain/damage-zones";
import type { MyInspection } from "../../domain/inspection-types";
import { groupByScope } from "./order";
import type { QueueItem, SaveAnswer } from "./types";

export type PendingDamage = {
  id: string;
  zone: string;
  zoneLabel: string;
  severity: string;
  description: string;
  reportedAt: string;
};

export type Overlay = {
  data: MyInspection;
  beginQueued: boolean;
  odometerQueued: boolean;
  defectPhotosQueued: Set<string>;
  damageQueued: PendingDamage[];
  submitQueued: boolean;
  /** Total items waiting for this inspection. */
  waiting: number;
};

export const localInspectionId = (scope: string) => `local:${scope}`;
export const isLocalInspectionId = (id: string | null | undefined) =>
  !!id && id.startsWith("local:");

export function applyQueue(
  server: MyInspection,
  allItems: QueueItem[],
  scope: string,
): Overlay {
  const items =
    groupByScope(allItems.filter((i) => i.scope === scope)).get(scope) ?? [];
  let data: MyInspection = structuredClone(server);
  const begin = items.find((i) => i.kind === "begin");
  if (!data.inspection && begin) {
    data.inspection = {
      id: localInspectionId(scope),
      status: "draft",
      vehicle_confirmed: false,
      known_damage_reviewed: false,
      completed_by_role: "driver",
      on_behalf_reason: null,
      viewer_is_completer: true,
      late_flag: false,
      safety_defect_flag: false,
      captured_offline: begin.capturedOffline,
      started_at: begin.deviceTime,
      submitted_at: null,
    };
  }
  const saves = items.filter((i) => i.payload.kind === "save");
  const lastSave = saves[saves.length - 1];
  if (lastSave && lastSave.payload.kind === "save" && data.inspection) {
    const answers = new Map<string, SaveAnswer>(
      lastSave.payload.responses.map((r) => [r.templateItemId, r]),
    );
    data = {
      ...data,
      items: data.items.map((it) => {
        const a = answers.get(it.template_item_id);
        return a
          ? { ...it, answer: { value: a.value, comment: a.comment ?? null } }
          : it;
      }),
      inspection: {
        ...data.inspection,
        vehicle_confirmed:
          data.inspection.vehicle_confirmed ||
          lastSave.payload.vehicleConfirmed,
      },
    };
  }
  if (items.some((i) => i.kind === "confirm_known") && data.inspection) {
    data = {
      ...data,
      known_damage_reviewed: true,
      inspection: { ...data.inspection, known_damage_reviewed: true },
    };
  }
  const odometerQueued = items.some(
    (i) => i.payload.kind === "photo" && i.payload.target.kind === "odometer",
  );
  const defectPhotosQueued = new Set<string>();
  for (const i of items)
    if (i.payload.kind === "photo" && i.payload.target.kind === "defect")
      defectPhotosQueued.add(i.payload.target.templateItemId);
  const damageQueued: PendingDamage[] = items.flatMap((i) =>
    i.payload.kind === "report_damage"
      ? [
          {
            id: `local:${i.csid}`,
            zone: i.payload.zone,
            zoneLabel: damageZoneLabel(i.payload.zone),
            severity: i.payload.severity,
            description: i.payload.description,
            reportedAt: i.deviceTime,
          },
        ]
      : [],
  );
  return {
    data,
    beginQueued: !!begin,
    odometerQueued,
    defectPhotosQueued,
    damageQueued,
    submitQueued: items.some((i) => i.kind === "submit"),
    waiting: items.length,
  };
}

/** The allocation as the driver should see it on this phone: queued (unsent) inspections move it on, marked as not sent yet. */
export function effectiveAllocation(
  a: { id: string; status: string; postShiftSubmitted: boolean },
  items: QueueItem[],
): { status: string; postShiftSubmitted: boolean; unsent: boolean } {
  const mine = items.filter((i) => i.allocationId === a.id);
  let status = a.status;
  let postShiftSubmitted = a.postShiftSubmitted;
  const preSubmit = mine.some(
    (i) => i.stage === "pre_shift" && i.kind === "submit",
  );
  const postBegun = mine.some((i) => i.stage === "post_shift");
  const postSubmit = mine.some(
    (i) => i.stage === "post_shift" && i.kind === "submit",
  );
  if (preSubmit && status === "pre_inspection_pending") status = "in_use";
  if (postBegun && status === "in_use") status = "post_inspection_pending";
  if (postSubmit) {
    status = "post_inspection_pending";
    postShiftSubmitted = true;
  }
  return { status, postShiftSubmitted, unsent: mine.length > 0 };
}
