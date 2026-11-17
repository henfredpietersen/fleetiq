// CSV parsing for the reviewed baseline import (PRD §5.10.7; DEC-20). Pure and tolerant of Excel exports:
// BOM, CRLF, quoted fields with commas / doubled quotes. Parsing only decides the SHAPE of the file; the database
// (stage_service_import) validates every value and is the authority for the validation report.

export const MAX_IMPORT_ROWS = 500; // same cap as stage_service_import
export const MAX_IMPORT_BYTES = 1_000_000;

export const IMPORT_FIELDS = [
  "registration_number",
  "service_date",
  "odometer_km",
  "service_type",
  "supplier_name",
  "job_reference",
  "invoice_reference",
] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];
export type ImportRow = Partial<Record<ImportField, string>>;

const REQUIRED: ImportField[] = [
  "registration_number",
  "service_date",
  "odometer_km",
  "service_type",
];

const ALIASES: Record<string, ImportField> = {
  registration_number: "registration_number",
  registration: "registration_number",
  reg: "registration_number",
  reg_number: "registration_number",
  service_date: "service_date",
  date: "service_date",
  odometer_km: "odometer_km",
  odometer: "odometer_km",
  km: "odometer_km",
  service_type: "service_type",
  type: "service_type",
  supplier_name: "supplier_name",
  supplier: "supplier_name",
  workshop: "supplier_name",
  job_reference: "job_reference",
  job_card: "job_reference",
  invoice_reference: "invoice_reference",
  invoice: "invoice_reference",
};

export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

export type ImportParse =
  | { ok: true; rows: ImportRow[] }
  | { ok: false; message: string; details?: string[] };

/** File text -> rows keyed by IMPORT_FIELDS, or a clear message about what is wrong with the file. */
export function parseImportFile(text: string): ImportParse {
  if (text.length > MAX_IMPORT_BYTES)
    return { ok: false, message: "The file is too large (limit about 1 MB)." };
  const table = parseCsv(text);
  if (table.length === 0) return { ok: false, message: "The file is empty." };
  const header = table[0].map((h) =>
    h
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, "_"),
  );
  const columns = header.map((h) => ALIASES[h] ?? null);
  const missing = REQUIRED.filter((f) => !columns.includes(f));
  if (missing.length > 0)
    return {
      ok: false,
      message: "The first row must be a header with the required columns.",
      details: missing.map((f) => `Missing column: ${f}`),
    };
  const dupes = columns.filter((c, i) => c && columns.indexOf(c) !== i);
  if (dupes.length > 0)
    return {
      ok: false,
      message: "A column appears more than once in the header.",
      details: [...new Set(dupes)].map((f) => `Repeated column: ${f}`),
    };
  const body = table.slice(1);
  if (body.length === 0)
    return { ok: false, message: "The file has a header but no rows." };
  if (body.length > MAX_IMPORT_ROWS)
    return {
      ok: false,
      message: `The file has ${body.length} rows; the limit is ${MAX_IMPORT_ROWS} per import. Split it and import in parts.`,
    };
  const rows = body.map((cells) => {
    const r: ImportRow = {};
    columns.forEach((f, i) => {
      if (f) r[f] = (cells[i] ?? "").trim();
    });
    return r;
  });
  return { ok: true, rows };
}

/** Machine codes returned by stage_service_import() -> words for the validation report. */
export const IMPORT_ERROR_LABELS: Record<string, string> = {
  missing_registration: "Registration number is missing",
  unknown_vehicle:
    "Vehicle not found (check the registration, or you may not record services for its branch)",
  invalid_date: "Service date is not a valid YYYY-MM-DD date",
  future_date: "Service date is in the future",
  invalid_odometer: "Odometer must be a whole number of km (digits only)",
  missing_service_type: "Service type is missing",
  field_too_long: "A value is too long",
  duplicate_in_file: "Duplicate of an earlier row in this file",
  duplicate_existing:
    "A service record for this vehicle, date and odometer already exists",
};

export const importErrorLabel = (code: string) =>
  IMPORT_ERROR_LABELS[code] ?? "Invalid value";

export function summariseRows(rows: readonly { row_status: string }[]) {
  const count = (s: string) => rows.filter((r) => r.row_status === s).length;
  return {
    total: rows.length,
    valid: count("valid"),
    invalid: count("invalid"),
    imported: count("imported"),
  };
}
