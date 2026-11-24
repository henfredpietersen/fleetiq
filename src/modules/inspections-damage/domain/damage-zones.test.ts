import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DAMAGE_SEVERITIES,
  DAMAGE_STATUSES,
  DAMAGE_ZONES,
  DAMAGE_ZONE_LABELS,
  damageTransitionAllowed,
  isFinalDamageStatus,
  isOpenDamageStatus,
  zoneLabel,
} from "./damage-zones";

const sql = readFileSync(
  join(process.cwd(), "supabase/migrations/20261124000046_damage_register.sql"),
  "utf8",
);

describe("damage zones mirror migration 046", () => {
  it("has the 13 DEC-42 zones, in the database's order", () => {
    const m = sql.match(/select array\[([^\]]+)\]\s*\$\$/);
    const sqlZones = [...m![1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
    expect(sqlZones).toEqual([...DAMAGE_ZONES]);
    expect(DAMAGE_ZONES).toHaveLength(13);
  });
  it("has the same display names as damage_zone_label()", () => {
    const labels = Object.fromEntries(
      [...sql.matchAll(/when '([a-z_]+)'\s+then '([^']+)'/g)].map((x) => [
        x[1],
        x[2],
      ]),
    );
    expect(labels).toEqual(DAMAGE_ZONE_LABELS);
    expect(zoneLabel("left_front")).toBe("Left front (door and wing)");
    expect(zoneLabel("nose")).toBe("nose");
  });
  it("has the same severities and statuses as the CHECKs", () => {
    expect(sql).toContain(
      `severity in (${DAMAGE_SEVERITIES.map((s) => `'${s}'`).join(", ")})`,
    );
    expect(sql).toContain(
      `status in (${DAMAGE_STATUSES.map((s) => `'${s}'`).join(", ")})`,
    );
  });
});

describe("damage status rules", () => {
  it("allows only reported -> verified | disputed and verified -> repaired", () => {
    const allowed = [
      ["reported", "verified"],
      ["reported", "disputed"],
      ["verified", "repaired"],
    ];
    for (const a of DAMAGE_STATUSES)
      for (const b of DAMAGE_STATUSES)
        expect(damageTransitionAllowed(a, b)).toBe(
          allowed.some(([x, y]) => x === a && y === b),
        );
  });
  it("disputed and repaired are final; reported and verified are open", () => {
    expect(["disputed", "repaired"].every(isFinalDamageStatus)).toBe(true);
    expect(["reported", "verified"].some(isFinalDamageStatus)).toBe(false);
    expect(["reported", "verified"].every(isOpenDamageStatus)).toBe(true);
    expect(["disputed", "repaired"].some(isOpenDamageStatus)).toBe(false);
  });
});
