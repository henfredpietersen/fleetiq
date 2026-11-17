import {
  grant,
  makeDriver,
  makeStaff,
  admin,
  type World,
} from "../tests/integration/helpers";

// Seeds SYNTHETIC users on local Supabase (service role, test infrastructure only). Runs only with E2E_AUTH=1.
export const E2E_COMPANY_ID = "00000000-0000-4000-8000-0000000000e2";

export default async function globalSetup() {
  if (process.env.E2E_AUTH !== "1") return;
  const sa = admin();
  await sa
    .from("companies")
    .upsert({ id: E2E_COMPANY_ID, name: "E2E synthetic company" });
  const { data: existing } = await sa
    .from("branches")
    .select("id")
    .eq("company_id", E2E_COMPANY_ID)
    .eq("branch_code", "E2E");
  let branchId = existing?.[0]?.id;
  if (!branchId) {
    branchId = (
      await sa
        .from("branches")
        .insert({
          company_id: E2E_COMPANY_ID,
          name: "E2E Branch",
          branch_code: "E2E",
        })
        .select("id")
        .single()
    ).data!.id;
  }
  const w: World = {
    companyId: E2E_COMPANY_ID,
    branchId,
    otherBranchId: branchId,
    sa,
  };
  const boot = await makeStaff(w, "e2e-boot", "system_admin", null);
  const run = Date.now().toString(36).toUpperCase();
  const specs = [
    { emp: `OK${run}`, pin: "482916", mustChange: false },
    { emp: `LK${run}`, pin: "482916", mustChange: false },
    { emp: `CP${run}`, pin: "482916", mustChange: true },
  ];
  for (const s of specs) {
    const d = await makeDriver(w, s.emp, s.pin, { mustChange: s.mustChange });
    await grant(w, d.id, "driver", branchId, boot.id);
  }
  process.env.E2E_EMP_OK = specs[0]!.emp;
  process.env.E2E_EMP_LOCK = specs[1]!.emp;
  process.env.E2E_EMP_CHANGE = specs[2]!.emp;
}
