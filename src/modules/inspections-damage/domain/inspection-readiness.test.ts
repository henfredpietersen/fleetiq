import { describe, expect, it } from "vitest";
import fixture from "./inspection-readiness.fixture.json";
import {
  canSubmit,
  submitBlockers,
  type ReadinessInput,
} from "./inspection-readiness";

const input = (c: (typeof fixture.cases)[number]): ReadinessInput => ({
  vehicleConfirmed: c.confirmed,
  knownDamageReviewed: (c as { known?: boolean }).known ?? true,
  registration: fixture.registration,
  items: fixture.items as ReadinessInput["items"],
  answers: c.answers as ReadinessInput["answers"],
  itemsWithPhoto: new Set(c.photos),
  odometerPhoto: c.odometer,
  readingEntered: (c as { reading?: boolean }).reading ?? true,
});

describe("submit readiness matches the server rules (IN001-IN007, IN015)", () => {
  for (const c of fixture.cases) {
    it(c.name, () => {
      const codes = submitBlockers(input(c)).map((b) => b.code);
      expect(codes).toEqual(c.expect);
      expect(canSubmit(input(c))).toBe(c.expect.length === 0);
    });
  }
  it("uses the server's wording, so the form and a refusal never disagree", () => {
    const b = submitBlockers(input(fixture.cases[2]!));
    expect(b[0]!.message).toBe(
      'Answer every required item before you submit: "Tyres" is not answered (3 still to answer).',
    );
    const v = submitBlockers(input(fixture.cases[1]!));
    expect(v[0]!.message).toBe(
      "Confirm that you are inspecting the vehicle shown (T4B-GP) before you submit.",
    );
  });
  it("points at the item that needs attention", () => {
    const b = submitBlockers(input(fixture.cases[6]!));
    expect(b[0]).toMatchObject({ code: "IN004", itemId: "tyres" });
  });
});
