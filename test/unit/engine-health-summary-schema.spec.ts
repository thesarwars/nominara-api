import { describe, expect, it } from "vitest";
import { engineHealthSummarySchema, readinessResponseSchema } from "../../contracts/common/health.schema.js";

// STORY-031 Phase A — AC10/D16: readiness gains an `engines[]` array (a
// contract change, landing before any consumer logic). `.strict()` on the
// summary entry per coding-standards.md §2 — an unknown key is a bug, not a
// silently-ignored extra field.

const VALID_ENTRY = {
  engineKey: "chatgpt",
  status: "active" as const,
  circuitState: "closed" as const,
  healthy: true,
};

describe("STORY-031 · engineHealthSummarySchema", () => {
  it("accepts a well-formed entry", () => {
    expect(engineHealthSummarySchema.safeParse(VALID_ENTRY).success).toBe(true);
  });

  it("rejects an unknown key (.strict())", () => {
    const result = engineHealthSummarySchema.safeParse({ ...VALID_ENTRY, unknownField: "x" });
    expect(result.success).toBe(false);
  });

  it("rejects a status value outside engines.status's own DB CHECK", () => {
    const result = engineHealthSummarySchema.safeParse({ ...VALID_ENTRY, status: "not_a_real_status" });
    expect(result.success).toBe(false);
  });

  it("rejects a circuitState value outside the breaker's three states", () => {
    const result = engineHealthSummarySchema.safeParse({ ...VALID_ENTRY, circuitState: "not_a_real_state" });
    expect(result.success).toBe(false);
  });

  it("rejects a missing engineKey", () => {
    const { engineKey: _drop, ...rest } = VALID_ENTRY;
    expect(engineHealthSummarySchema.safeParse(rest).success).toBe(false);
  });
});

describe("STORY-031 · readinessResponseSchema gains engines[]", () => {
  const validReadiness = {
    status: "ready" as const,
    migrationVersion: { applied: "0001", expected: "0001", matches: true },
    dependencies: [],
    queues: [],
    engines: [VALID_ENTRY],
  };

  it("accepts a readiness document with a populated engines[] array", () => {
    expect(readinessResponseSchema.safeParse(validReadiness).success).toBe(true);
  });

  it("accepts a readiness document with an empty engines[] array (the reserved state before this story's health.service.ts phase wires it)", () => {
    expect(readinessResponseSchema.safeParse({ ...validReadiness, engines: [] }).success).toBe(true);
  });

  it("rejects a readiness document with engines[] absent entirely — it is a required field, not optional", () => {
    const { engines: _drop, ...rest } = validReadiness;
    expect(readinessResponseSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects a readiness document whose engines[] entry carries an unknown key", () => {
    const invalid = { ...validReadiness, engines: [{ ...VALID_ENTRY, extra: "x" }] };
    expect(readinessResponseSchema.safeParse(invalid).success).toBe(false);
  });
});
