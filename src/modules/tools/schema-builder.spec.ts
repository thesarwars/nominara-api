import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  SCHEMA_BUILDER_ENTITY_TYPES,
  SCHEMA_BUILDER_RULE_CODES,
  schemaBuilderRequestSchema,
} from "../../../contracts/tools/index.js";

// STORY-083 (owner decision 78a) - the Save route. Build and Check run in the browser; the API takes findings only. Scenario numbers are the story's table.

const finding = { rule_code: "AUX-R-012", severity: "high", position: null, field: "offers.price" };
const check = { mode: "check", entity_type: null, vocab_version: "schema-vocab@2026.08", findings: [finding] };

describe("STORY-083 · the save request carries findings only", () => {
  it("scenario 7 - a parse finding names its position as numbers, and carries none of the pasted text", () => {
    const parsed = schemaBuilderRequestSchema.safeParse({ ...check, findings: [{ rule_code: "AUX-R-008", severity: "critical", position: { line: 3, column: 14 }, field: null }] });
    expect(parsed.success).toBe(true);
    expect(schemaBuilderRequestSchema.safeParse({ ...check, findings: [{ rule_code: "AUX-R-008", severity: "critical", position: { line: 3, column: 14, text: "{" }, field: null }] }).success).toBe(false);
  });

  it("scenario 6 - pasted markup, a snippet, a parser message or free text is a 400 shape, not a dropped key", () => {
    for (const extra of [{ markup: "{}" }, { text: "{}" }, { json_ld: "{}" }, { url: "https://a.test/" }]) {
      expect(schemaBuilderRequestSchema.safeParse({ ...check, ...extra }).success, JSON.stringify(extra)).toBe(false);
    }
    for (const extra of [{ detail: "Unexpected token" }, { snippet: "<script>" }, { message: "x" }, { consequence: "Engines cannot show your price" }]) {
      expect(schemaBuilderRequestSchema.safeParse({ ...check, findings: [{ ...finding, ...extra }] }).success, JSON.stringify(extra)).toBe(false);
    }
  });

  it("scenario 6 - a field is a property path, so a value cannot ride in it", () => {
    for (const field of ['{"@type":"Product"}', "offers price", "<script>", "a".repeat(81), ""]) {
      expect(schemaBuilderRequestSchema.safeParse({ ...check, findings: [{ ...finding, field }] }).success, field).toBe(false);
    }
    for (const field of ["offers.price", "@type", "aggregateRating.reviewCount", null]) {
      expect(schemaBuilderRequestSchema.safeParse({ ...check, findings: [{ ...finding, field }] }).success, String(field)).toBe(true);
    }
  });

  it("scenario 1 - every one of the nine entity types is a valid build, and a tenth is not", () => {
    expect(SCHEMA_BUILDER_ENTITY_TYPES).toHaveLength(9);
    for (const entity_type of SCHEMA_BUILDER_ENTITY_TYPES) {
      expect(schemaBuilderRequestSchema.safeParse({ ...check, mode: "build", entity_type, findings: [] }).success, entity_type).toBe(true);
    }
    expect(schemaBuilderRequestSchema.safeParse({ ...check, mode: "build", entity_type: "Recipe", findings: [] }).success).toBe(false);
  });

  it("scenario 4 - a build must name its entity type and a check must not; an empty findings list is a valid, clean save", () => {
    expect(schemaBuilderRequestSchema.safeParse({ ...check, mode: "build", entity_type: null }).success).toBe(false);
    expect(schemaBuilderRequestSchema.safeParse({ ...check, mode: "check", entity_type: "Product" }).success).toBe(false);
    expect(schemaBuilderRequestSchema.safeParse({ ...check, findings: [] }).success).toBe(true);
  });

  it("scenario 5 - only structured_data rules are accepted, and the held contradiction rule is not", () => {
    expect(SCHEMA_BUILDER_RULE_CODES).not.toContain("AUX-R-013");
    for (const rule_code of ["AUX-R-013", "AUX-R-001", "AUX-R-019", "AUX-R-019x"]) {
      expect(schemaBuilderRequestSchema.safeParse({ ...check, findings: [{ ...finding, rule_code }] }).success, rule_code).toBe(false);
    }
  });

  it("boundary - 50 findings pass and 51 do not; the vocabulary version has a fixed shape; positions start at 1", () => {
    expect(schemaBuilderRequestSchema.safeParse({ ...check, findings: Array.from({ length: 50 }, () => finding) }).success).toBe(true);
    expect(schemaBuilderRequestSchema.safeParse({ ...check, findings: Array.from({ length: 51 }, () => finding) }).success).toBe(false);
    expect(schemaBuilderRequestSchema.safeParse({ ...check, vocab_version: "latest" }).success).toBe(false);
    expect(schemaBuilderRequestSchema.safeParse({ ...check, findings: [{ ...finding, position: { line: 0, column: 1 } }] }).success).toBe(false);
  });
});

describe("STORY-083 · scenario 9 - the service has no path to a model, an engine, a queue or the network", () => {
  const file = path.join(import.meta.dirname, "schema-builder.service.ts");
  it("scenario 9 - no import line names a forbidden module and the file makes no call out", () => {
    const text = readFileSync(file, "utf8");
    const imports = text.split("\n").filter((line) => /^\s*(import|export)\b.*\bfrom\b/u.test(line) || /\bimport\(/u.test(line));
    expect(imports.length).toBeGreaterThan(0);
    for (const line of imports) {
      expect(line).not.toMatch(/queue|capture|engine|embedding|model|llm|guarded-fetch|url-guard|storage|wallet|credits\//iu);
    }
    expect(text).not.toMatch(/fetch\(|new Worker|\.add\(|enqueue|debitInTransaction/u);
  });
});
