// Licence codes and class coverage (DEC-22, amended 2026-11-18; regulation 99 of the National Road Traffic
// Regulations, 2000). Pure mirror of the SQL function public.licence_code_coverage(held, required): the SQL is
// authoritative; both are tested against licence-code-coverage.fixture.json (all 64 pairs, plus nulls).
export const LICENCE_CODES = [
  "A1",
  "A",
  "B",
  "C1",
  "C",
  "EB",
  "EC1",
  "EC",
] as const;
export type LicenceCode = (typeof LICENCE_CODES)[number];

const COVERED_BY: Record<LicenceCode, readonly LicenceCode[]> = {
  A1: ["A"],
  A: [],
  B: ["C1", "C", "EB", "EC1", "EC"],
  C1: ["C", "EC1", "EC"],
  C: ["EC"],
  EB: ["EC1", "EC"],
  EC1: ["EC"],
  EC: [],
};

export function isLicenceCode(v: unknown): v is LicenceCode {
  return (
    typeof v === "string" && (LICENCE_CODES as readonly string[]).includes(v)
  );
}

/** True when a licence of code `held` lets the driver drive a vehicle that requires `required`. Unknown or null -> false. */
export function licenceCodeCovers(
  held: string | null | undefined,
  required: string | null | undefined,
): boolean {
  if (!isLicenceCode(held) || !isLicenceCode(required)) return false;
  return held === required || COVERED_BY[required].includes(held);
}

/** Short guidance shown beside the "Required licence code" field. */
export const LICENCE_CODE_GUIDANCE: readonly { codes: string; text: string }[] =
  [
    { codes: "B", text: "Light vehicles, up to 3,500 kg GVM" },
    { codes: "C1", text: "Over 3,500 kg and up to 16,000 kg GVM" },
    { codes: "C", text: "Over 16,000 kg GVM" },
    {
      codes: "EB / EC1 / EC",
      text: "The same classes with a trailer over 750 kg, or articulated",
    },
    { codes: "A1 / A", text: "Motorcycles" },
  ];
