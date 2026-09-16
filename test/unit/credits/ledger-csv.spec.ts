import { describe, expect, it } from "vitest";
import type { CreditLedgerEntry } from "../../../contracts/billing/index.js";
import { toLedgerCsv } from "../../../src/modules/billing/credit-ledger.reader.js";

// STORY-073 AC12 — the export half.
//
// Pure, so the whole matrix of hostile field values is a unit test rather
// than something discovered in a spreadsheet.

function entry(over: Partial<CreditLedgerEntry> = {}): CreditLedgerEntry {
  return {
    id: "11111111-1111-7111-8111-111111111111",
    entry_type: "commit",
    action_code: "manual_scan",
    credits: 40,
    bucket: null,
    included_after: 560,
    purchased_after: 0,
    reserved_after: 0,
    actor_id: "22222222-2222-7222-8222-222222222222",
    actor_pseudonym: null,
    actor_type: "user",
    project_id: "33333333-3333-7333-8333-333333333333",
    reference_type: "run",
    reference_id: "44444444-4444-7444-8444-444444444444",
    unit_detail: { prompts: 15, engines: 2, cells_charged: 22, cells_cached: 8 },
    reason: null,
    occurred_at: "2026-09-16T10:00:00.000Z",
    ...over,
  };
}

function rows(csv: string): string[] {
  return csv.split("\r\n").filter((line) => line !== "");
}

describe("STORY-073 · the ledger CSV export", () => {
  it("writes a header even when there is nothing to export", () => {
    // An empty file is indistinguishable from a failed download. A header
    // alone says "we looked, and there was nothing".
    const csv = toLedgerCsv([]);
    expect(rows(csv)).toHaveLength(1);
    expect(csv).toContain("occurred_at");
  });

  it("flattens unit_detail into its own columns, so a spreadsheet can sum them", () => {
    const [header, row] = rows(toLedgerCsv([entry()]));
    const columns = header!.split(",").map((c) => c.replaceAll('"', ""));
    const values = row!.split(",").map((c) => c.replaceAll('"', ""));

    expect(values[columns.indexOf("cells_charged")]).toBe("22");
    expect(values[columns.indexOf("cells_cached")]).toBe("8");
  });

  it("leaves the unit columns empty rather than zero when there is no detail", () => {
    // ⚠ EMPTY IS NOT ZERO. A grant has no cell split; writing 0 would claim
    // it charged zero cells, which is a measurement nobody took.
    //
    // Read by COLUMN NAME rather than by looking for a run of empty fields.
    // The substring version passed against a mutant that zeroed `prompts`,
    // because a grant row has other adjacent empties for the run to match.
    const csv = toLedgerCsv([entry({ entry_type: "grant", unit_detail: null, action_code: null })]);
    const [header, row] = rows(csv);
    const columns = header!.split(",").map((c) => c.replaceAll('"', ""));
    const values = row!.split(",").map((c) => c.replaceAll('"', ""));

    for (const column of ["prompts", "engines", "cells_charged", "cells_cached"]) {
      expect(values[columns.indexOf(column)], `${column} should be empty, not zero`).toBe("");
    }
  });

  it("⚠ quotes a reason containing a comma, so one entry cannot become two columns", () => {
    const csv = toLedgerCsv([entry({ entry_type: "adjustment", reason: "goodwill, per ticket 41" })]);
    expect(rows(csv)).toHaveLength(2);
    expect(csv).toContain('"goodwill, per ticket 41"');
  });

  it("⚠ doubles an embedded quote rather than ending the field early", () => {
    const csv = toLedgerCsv([entry({ entry_type: "adjustment", reason: 'they said "refund it"' })]);
    expect(csv).toContain('"they said ""refund it"""');
    expect(rows(csv)).toHaveLength(2);
  });

  it("⚠ keeps a newline inside its field instead of splitting the row", () => {
    // A reason is free text a human typed into a form. They press Enter.
    const csv = toLedgerCsv([entry({ entry_type: "adjustment", reason: "line one\nline two" })]);
    // Two CRLF-delimited records, even though the payload contains an LF.
    expect(rows(csv)).toHaveLength(2);
    expect(csv).toContain('"line one\nline two"');
  });

  for (const prefix of ["=", "+", "-", "@"]) {
    it(`⚠ defuses a ${prefix}-prefixed value, which Excel would execute as a formula`, () => {
      // A billing export is exactly the file somebody opens in Excel, and a
      // reason field is free text somebody else wrote. `=HYPERLINK(...)` in a
      // cell is a known exfiltration path.
      const csv = toLedgerCsv([entry({ entry_type: "adjustment", reason: `${prefix}HYPERLINK("http://x")` })]);
      expect(csv).toContain(`"\t${prefix}HYPERLINK`);
    });
  }

  it("does not prefix a value that merely contains one of those characters", () => {
    // Over-escaping makes every negative number unreadable. Only a LEADING
    // character starts a formula.
    const csv = toLedgerCsv([entry({ entry_type: "adjustment", reason: "credit 40-50 range" })]);
    expect(csv).toContain('"credit 40-50 range"');
    expect(csv).not.toContain("\tcredit");
  });

  it("⚠ carries a NEGATIVE adjustment through as a negative number", () => {
    // `-40` starts with `-`, so the formula guard fires — and the value must
    // still be readable as a number by whoever opens the file. The tab is the
    // reason this is a separate assertion from the one above.
    const csv = toLedgerCsv([entry({ entry_type: "adjustment", credits: -40, bucket: "included", reason: "clawback" })]);
    expect(csv).toContain('"\t-40"');
  });

  it("ends every record with CRLF, which is what RFC 4180 and Excel expect", () => {
    const csv = toLedgerCsv([entry()]);
    expect(csv.endsWith("\r\n")).toBe(true);
    expect(csv.split("\r\n")).toHaveLength(3);
  });
});
