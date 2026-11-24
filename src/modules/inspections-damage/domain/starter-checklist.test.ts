import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import fixture from "./starter-checklist.fixture.json";
import { RESPONSE_TYPES } from "./inspection-rules";

// DEC-21: the starter checklist v1 is seeded exactly. The same fixture drives the pgTAP test
// (scripts/gen-starter-checklist-test.mjs -> phase4a_starter_checklist.test.sql), which compares it with the seeded rows.
// Here the fixture is checked against its own shape and against the text of the seed migration.
type Item = (typeof fixture.items)[number];
const pre = fixture.items.filter((i) => i.stage === "pre_shift");
const post = fixture.items.filter((i) => i.stage === "post_shift");

describe("starter checklist v1 fixture", () => {
  it("is the Starter checklist, version 1, for all categories", () => {
    expect(fixture.template).toEqual({
      name: "Starter checklist",
      version: 1,
      vehicleCategory: null,
    });
  });
  it("has 20 pre-shift and 7 post-shift items, numbered 1..n in order", () => {
    expect(pre).toHaveLength(20);
    expect(post).toHaveLength(7);
    expect(pre.map((i) => i.sequence)).toEqual(pre.map((_, n) => n + 1));
    expect(post.map((i) => i.sequence)).toEqual(post.map((_, n) => n + 1));
    expect(fixture.items).toHaveLength(27);
  });
  it("keys are unique, snake_case, and response types are known", () => {
    const keys = fixture.items.map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const i of fixture.items) {
      expect(i.key).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(RESPONSE_TYPES as readonly string[]).toContain(i.responseType);
      expect(i.question).toBe(i.question.trim());
    }
  });
  it("the safety-critical items are exactly the approved ones", () => {
    const sc = fixture.items.filter((i) => i.safetyCritical).map((i) => i.key);
    expect(sc).toEqual([
      "tyres",
      "wheel_nuts",
      "lights",
      "windscreen_wipers",
      "no_leaks",
      "seatbelts",
      "brakes",
      "warning_lights",
      "post_tyres",
      "post_lights",
      "post_warning_lights",
    ]);
  });
  it("only the four equipment items accept N/A, and only ok/defect items can", () => {
    const na = fixture.items.filter((i) => i.allowNa).map((i) => i.key);
    expect(na).toEqual([
      "warning_triangle",
      "fire_extinguisher",
      "first_aid_kit",
      "jack_spanner",
    ]);
    for (const i of fixture.items.filter((x) => x.allowNa))
      expect(i.responseType).toBe("ok_defect");
  });
  it("fuel is a fuel_quarter item and the incident question is yes/no with detail", () => {
    const by = (k: string) => fixture.items.find((i) => i.key === k) as Item;
    expect(by("fuel_level").responseType).toBe("fuel_quarter");
    expect(by("post_fuel_level").responseType).toBe("fuel_quarter");
    expect(by("post_incident").responseType).toBe("yes_no_detail");
    expect(
      fixture.items.filter((i) => i.responseType === "yes_no_detail"),
    ).toHaveLength(1);
  });
});

describe("starter checklist v1: the seed migration matches the fixture", () => {
  const sql = readFileSync(
    new URL(
      "../../../../supabase/migrations/20261117000037_inspection_templates.sql",
      import.meta.url,
    ),
    "utf8",
  );
  // one row per line: ('pre_shift', 1, 'tyres', 'question', 'ok_defect', true, false),
  const re =
    /^\s*\('(pre_shift|post_shift)', (\d+), '([a-z_]+)', '((?:[^']|'')*)', '(ok_defect|fuel_quarter|yes_no_detail)', (true|false), (true|false)\),?$/gm;
  const rows = [...sql.matchAll(re)].map((m) => ({
    stage: m[1],
    sequence: Number(m[2]),
    key: m[3],
    question: m[4].replace(/''/g, "'"),
    responseType: m[5],
    safetyCritical: m[6] === "true",
    allowNa: m[7] === "true",
  }));
  it("seeds exactly the fixture's items, in order", () => {
    expect(rows).toEqual(fixture.items);
  });
  it("seeds every item as required, under the name and version of the fixture", () => {
    expect(sql).toMatch(/s\.response_type, true, s\.stage, s\.seq/);
    expect(sql).toContain(
      `'${fixture.template.name}', null, ${fixture.template.version}, 'active'`,
    );
  });
});
