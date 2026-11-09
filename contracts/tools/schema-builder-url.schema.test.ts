import { describe, expect, it } from "vitest";
import { schemaBuilderUrlAcceptedSchema, schemaBuilderUrlJobPayloadSchema, schemaBuilderUrlRequestSchema, schemaBuilderUrlResultSchema } from "./index.js";

const ID = "0192f0aa-0000-7000-8000-000000000001";
const finding = { consequence: "Engines can name you but cannot show your price", title: "Offer data absent", rule_code: "AUX-R-010", severity: "high", position: null, field: "offers.price" };

describe("POST /tools/schema-builder/url · contract", () => {
  it("SU-C1 the request is strict and takes one http(s) url", () => {
    expect(schemaBuilderUrlRequestSchema.safeParse({ url: "https://a.test/p" }).success).toBe(true);
    expect(schemaBuilderUrlRequestSchema.safeParse({ url: "file:///etc/passwd" }).success).toBe(false);
    expect(schemaBuilderUrlRequestSchema.safeParse({ url: "https://a.test/p", markup: "<x>" }).success).toBe(false);
  });
  it("SU-C2 the 202 is free and names the run as running", () => {
    const ok = { tool_run_id: ID, tool_key: "schema_builder", mode: "check", source: "url", status: "running", credits_charged: 0, poll: `/v1/tools/runs/${ID}` };
    expect(schemaBuilderUrlAcceptedSchema.safeParse(ok).success).toBe(true);
    expect(schemaBuilderUrlAcceptedSchema.safeParse({ ...ok, credits_charged: 1 }).success).toBe(false);
  });
  it("SU-C3 a pending result states nothing about the page, and a checked one can hold zero findings (a real, distinct answer)", () => {
    expect(schemaBuilderUrlResultSchema.safeParse({ schema_version: 1, source: "url", state: "pending" }).success).toBe(true);
    expect(schemaBuilderUrlResultSchema.safeParse({ schema_version: 1, source: "url", state: "pending", findings: [] }).success).toBe(false);
    const checked = { schema_version: 1, source: "url", state: "checked", mode: "check", entity_type: null, vocab_version: "aux-rules@2026.10.1", rules_evaluated: 10, findings: [], findings_omitted: 0 };
    expect(schemaBuilderUrlResultSchema.safeParse(checked).success).toBe(true);
    expect(schemaBuilderUrlResultSchema.safeParse({ ...checked, findings: [finding] }).success).toBe(true);
    expect(schemaBuilderUrlResultSchema.safeParse({ ...checked, rules_evaluated: 0 }).success).toBe(true);
  });
  it("SU-C4 an unreachable page carries a short reason and no finding", () => {
    expect(schemaBuilderUrlResultSchema.safeParse({ schema_version: 1, source: "url", state: "unreachable", reason: "http_error" }).success).toBe(true);
    expect(schemaBuilderUrlResultSchema.safeParse({ schema_version: 1, source: "url", state: "unreachable", reason: "connect ECONNREFUSED 10.0.0.1" }).success).toBe(false);
    expect(schemaBuilderUrlResultSchema.safeParse({ schema_version: 1, source: "url", state: "unreachable", reason: "refused", findings: [] }).success).toBe(false);
  });
  it("SU-C5 the job payload is the signed lookup.execute shape for the schema_builder tool", () => {
    const payload = { tool: "schema_builder", toolRunId: ID, targetUrl: "https://a.test/p", startedAt: "2026-11-09T10:00:00.000Z" };
    expect(schemaBuilderUrlJobPayloadSchema.safeParse(payload).success).toBe(true);
    expect(schemaBuilderUrlJobPayloadSchema.safeParse({ ...payload, tool: "aux_audit" }).success).toBe(false);
  });
});
