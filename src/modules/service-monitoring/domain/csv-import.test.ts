import { describe, expect, it } from "vitest";
import {
  MAX_IMPORT_ROWS,
  importErrorLabel,
  parseCsv,
  parseImportFile,
  summariseRows,
} from "./csv-import";

const HEADER =
  "registration_number,service_date,odometer_km,service_type,supplier_name,job_reference,invoice_reference";

describe("parseCsv", () => {
  it("handles BOM, CRLF, quotes, commas and doubled quotes", () => {
    const t = '﻿a,b\r\n"x, y","say ""hi"""\r\n';
    expect(parseCsv(t)).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"'],
    ]);
  });
  it("skips blank lines and keeps a last line without a newline", () => {
    expect(parseCsv("a,b\n\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});

describe("parseImportFile", () => {
  it("maps a valid file and trims values", () => {
    const r = parseImportFile(
      `${HEADER}\nTEST001-GP, 2026-10-01 ,82400,Scheduled service,Synthetic Workshop,JC-1,INV-1`,
    );
    expect(r).toEqual({
      ok: true,
      rows: [
        {
          registration_number: "TEST001-GP",
          service_date: "2026-10-01",
          odometer_km: "82400",
          service_type: "Scheduled service",
          supplier_name: "Synthetic Workshop",
          job_reference: "JC-1",
          invoice_reference: "INV-1",
        },
      ],
    });
  });
  it("accepts header aliases in any case", () => {
    const r = parseImportFile(
      "Registration,Date,Odometer,Type\nTEST001-GP,2026-10-01,1,Service",
    );
    expect(r.ok && r.rows[0]).toMatchObject({
      registration_number: "TEST001-GP",
      odometer_km: "1",
    });
  });
  it("reports missing required columns", () => {
    const r = parseImportFile("registration_number,service_date\nA,2026-01-01");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.details).toEqual([
      "Missing column: odometer_km",
      "Missing column: service_type",
    ]);
  });
  it("rejects empty, header-only, duplicate-column and oversized files", () => {
    expect(parseImportFile("").ok).toBe(false);
    expect(parseImportFile(HEADER).ok).toBe(false);
    expect(
      parseImportFile(
        "registration,reg,service_date,odometer_km,service_type\n1,2,3,4,5",
      ).ok,
    ).toBe(false);
    const big = [
      HEADER,
      ...Array.from(
        { length: MAX_IMPORT_ROWS + 1 },
        () => "A,2026-01-01,1,S,,,",
      ),
    ].join("\n");
    expect(parseImportFile(big).ok).toBe(false);
  });
  it("leaves value validation to the database (a bad date still parses)", () => {
    expect(parseImportFile(`${HEADER}\nA,2026-02-30,12 000,S,,,`).ok).toBe(
      true,
    );
  });
});

describe("report helpers", () => {
  it("labels known codes and falls back safely", () => {
    expect(importErrorLabel("duplicate_in_file")).toMatch(/earlier row/);
    expect(importErrorLabel("something_new")).toBe("Invalid value");
  });
  it("summarises row statuses", () => {
    expect(
      summariseRows([
        { row_status: "valid" },
        { row_status: "invalid" },
        { row_status: "imported" },
        { row_status: "valid" },
      ]),
    ).toEqual({ total: 4, valid: 2, invalid: 1, imported: 1 });
  });
});
