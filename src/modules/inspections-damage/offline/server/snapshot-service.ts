import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import type { Outcome } from "@/modules/fleet-vehicles/domain/action-state";
import { cameraNoticeAcknowledged } from "@/modules/evidence-storage/server/notice-query";
import { listMyAllocations } from "@/modules/shifts-allocations/server/lifecycle-service";
import { OFFLINE_CONFIG } from "../domain/config";
import type { Snapshot, SnapshotAllocation, Stage } from "../domain/types";
import { getMyInspection } from "../../server/inspection-service";

type Db = SupabaseClient<Database>;
const TERMINAL = new Set([
  "closed",
  "closed_with_exceptions",
  "cancelled",
  "no_show",
]);

/** Which stages' forms the phone needs for an allocation in this status. */
export function stagesFor(status: string): Stage[] {
  if (TERMINAL.has(status)) return [];
  return status === "planned" ? ["pre_shift"] : ["pre_shift", "post_shift"];
}

/**
 * DEC-43: the driver's allocations starting or running in the next 24 hours (plus ones that began up to 12 hours ago and are
 * still open), each with the vehicle, the checklist (the template items of the version in use), the known-damage list and the
 * current draft state — the my_inspection documents. Only the caller's own data; no photos, no signed URLs, nobody else's data.
 */
export async function buildSnapshot(
  db: Db,
  profileId: string,
  now: Date = new Date(),
): Promise<Outcome<{ snapshot: Snapshot }>> {
  const from = new Date(
    now.getTime() - OFFLINE_CONFIG.snapshotLookBackHours * 3_600_000,
  );
  const to = new Date(
    now.getTime() + OFFLINE_CONFIG.snapshotHorizonHours * 3_600_000,
  );
  const r = await listMyAllocations(db, {
    from: from.toISOString(),
    to: to.toISOString(),
  });
  if (!r.ok) return r;
  const allocations: SnapshotAllocation[] = [];
  for (const a of r.allocations) {
    const stages = stagesFor(a.status);
    if (stages.length === 0) continue;
    const inspections: SnapshotAllocation["inspections"] = {};
    for (const stage of stages) {
      const i = await getMyInspection(db, { allocationId: a.id, stage });
      if (i.ok) inspections[stage] = i.inspection;
    }
    allocations.push({
      allocation: {
        id: a.id,
        status: a.status,
        plannedStartAt: a.plannedStartAt,
        plannedEndAt: a.plannedEndAt,
        shiftStartAt: a.shiftStartAt,
        shiftEndAt: a.shiftEndAt,
        fleetNumber: a.fleetNumber,
        registration: a.registration,
        make: a.make,
        model: a.model,
        branchName: a.branchName,
        canOpen: a.canOpen,
        openedOnBehalf: a.openedOnBehalf,
        postShiftSubmitted: a.postShiftSubmitted,
      },
      inspections,
    });
  }
  return {
    ok: true,
    snapshot: {
      profileId,
      generatedAt: now.toISOString(),
      noticeAcknowledged: await cameraNoticeAcknowledged(db),
      allocations,
    },
  };
}
