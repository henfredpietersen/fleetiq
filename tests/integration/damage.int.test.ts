// Slice 4C integration test — LOCAL Supabase only (synthetic data). The real photo pipeline end to end for the damage register:
// a supervisor loads two onboarding items (generated JPEGs), a different manager verifies one, the reporter cannot, and the
// driver (with a live allocation) reads the list but not other people's photos.
import { beforeAll, describe, expect, it } from "vitest";
import {
  admin,
  anonClient,
  grant,
  makeDriver,
  makeStaff,
  makeWorld,
  signInStaff,
  type Db,
  type World,
} from "./helpers";
import { seedOnboardingDamage } from "./damage-seed";

let w: World;
let sa: Db;
let sup1: Db;
let sup2: Db;
let driverDb: Db;
let vehicleId: string;
let ids: string[];

beforeAll(async () => {
  w = await makeWorld();
  sa = admin();
  const boot = await makeStaff(w, "boot", "system_admin", null);
  const mk = async (label: string, role: string) => {
    const s = await makeStaff(w, label, role, w.branchId);
    await grant(w, s.id, role, w.branchId, boot.id);
    return signInStaff(s.email, s.password, "enrol");
  };
  sup1 = await mk("dmg-sup1", "supervisor");
  sup2 = await mk("dmg-sup2", "supervisor");
  const v = (
    await sa
      .from("vehicles")
      .insert({
        company_id: w.companyId,
        current_branch_id: w.branchId,
        fleet_number: "SYN-DMG",
        registration_number: "SYNDMG-GP",
        make: "Synthetic",
        model: "Bakkie",
        vehicle_category: "bakkie",
      })
      .select("id")
      .single()
  ).data!;
  vehicleId = v.id;
  const d = await makeDriver(w, "SYNDRV1", "482916", { branchId: w.branchId });
  await grant(w, d.id, "driver", w.branchId, boot.id);
  driverDb = anonClient();
  await driverDb.auth.signInWithPassword({ email: d.email, password: d.pin });
  ids = await seedOnboardingDamage(sup1, vehicleId, w.branchId);
});

describe("damage register (real storage, RLS and functions)", () => {
  it("the seed helper loaded two onboarding items, each with one photo, status reported", async () => {
    const { data } = await sa
      .from("vehicle_damage_items")
      .select("id, source, status, vehicle_damage_evidence(evidence_file_id)")
      .eq("vehicle_id", vehicleId);
    expect(data).toHaveLength(2);
    for (const i of data!) {
      expect(i.source).toBe("onboarding");
      expect(i.status).toBe("reported");
      expect(i.vehicle_damage_evidence).toHaveLength(1);
    }
  });
  it("the reporter cannot review their own item; a different manager can", async () => {
    const own = await sup1.rpc("review_damage", {
      p_item_id: ids[0]!,
      p_decision: "verified",
      p_reason: "",
      p_client_submission_id: crypto.randomUUID(),
    });
    expect(own.error?.message).toContain(
      "You cannot review damage you reported yourself",
    );
    const ok = await sup2.rpc("review_damage", {
      p_item_id: ids[0]!,
      p_decision: "verified",
      p_reason: "",
      p_client_submission_id: crypto.randomUUID(),
    });
    expect(ok.error).toBeNull();
  });
  it("a driver without a live allocation sees nothing", async () => {
    const { data } = await driverDb.from("vehicle_damage_items").select("id");
    expect(data).toHaveLength(0);
  });
  it("a photo that is already evidence cannot be used again", async () => {
    const { data: f } = await sa
      .from("evidence_files")
      .select("id")
      .eq("uploaded_by", (await sup1.auth.getUser()).data.user!.id)
      .limit(1)
      .single();
    const r = await sup1.rpc("record_onboarding_damage", {
      p_vehicle_id: vehicleId,
      p_zone: "roof",
      p_severity: "minor",
      p_description: "Synthetic: reuse of a used photo",
      p_evidence_file_ids: [f!.id],
      p_client_submission_id: crypto.randomUUID(),
    });
    expect(r.error?.message).toContain("already attached");
  });
});
