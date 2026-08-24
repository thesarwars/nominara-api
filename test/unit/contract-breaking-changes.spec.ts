import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// STORY-024 T12 — NFR-API-04: "within `v1` only additive changes ship."
//
// STORY-024 T11 shipped one change that was NOT additive: every response
// body became api-specification.md §1's envelope. The substance was right —
// the document had been describing a body the server stopped sending at T10,
// so there was no compatible option — but the HANDLING was not. T11 changed
// the previous-minor baseline AND the fixture consumer in the same commit,
// so client-previous-minor.spec.ts, the only gate for N-1 compatibility,
// had both of its inputs moved and went green proving nothing about the
// break that provoked it. The only record was prose in a commit message and
// in the fixture's `info.description`, and neither is a gate: prose cannot
// be re-checked, and it never expires.
//
// This file turns that into something mechanical. Each recorded change must
// still be VISIBLE in the committed document, so reverting one silently
// turns the build red, and removing the record becomes a deliberate act
// rather than a side effect. It deliberately does NOT try to detect breaking
// changes in general — that is what the consumer-compiles gate in
// client-previous-minor.spec.ts does. This one keeps the waivers honest.
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

interface RecordedChange {
  readonly id: string;
  readonly recorded: string;
  readonly story: string;
  readonly reason: string;
  readonly breaking: boolean;
  readonly assert: {
    readonly operation: string;
    readonly path: string;
    readonly method: string;
    readonly status: string;
    readonly response_properties: string[];
  };
}

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(resolve(REPO_ROOT, relativePath), "utf8")) as T;
}

const record = readJson<{ changes: RecordedChange[] }>("contracts/baseline/breaking-changes.json");
const document = readJson<Record<string, never>>("contracts/openapi.generated.json");
const baseline = readJson<Record<string, never>>("contracts/baseline/openapi.previous-minor.json");

function responseSchemaOf(doc: Record<string, never>, change: RecordedChange): Record<string, unknown> | undefined {
  const paths = (doc as { paths?: Record<string, Record<string, unknown>> }).paths;
  const operation = paths?.[change.assert.path]?.[change.assert.method] as
    | { responses?: Record<string, { content?: Record<string, { schema?: Record<string, unknown> }> }> }
    | undefined;
  return operation?.responses?.[change.assert.status]?.content?.["application/json"]?.schema;
}

describe("NFR-API-04 · every recorded breaking change stays visible in the contract", () => {
  it("the record is not empty — T11's envelope change is in it", () => {
    expect(record.changes.length).toBeGreaterThan(0);
    expect(record.changes.map((change) => change.id)).toContain("2026-08-24-response-envelope");
  });

  it.each(record.changes.map((change) => [change.id, change] as const))(
    "%s carries the fields that make it auditable rather than a bare flag",
    (_id, change) => {
      // A waiver whose reason is "made the test pass" is worse than none;
      // these fields are what let a later reader judge whether it still holds.
      expect(change.recorded, "a waiver must say WHEN it was taken").toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(change.story, "a waiver must name the story that took it").toMatch(/^STORY-\d+$/);
      expect(change.reason.length, "a waiver must carry a reason a reader can weigh").toBeGreaterThan(120);
      expect(change.breaking).toBe(true);
    },
  );

  it.each(record.changes.map((change) => [change.id, change] as const))(
    "%s is still exhibited by the CURRENT document — reverting it turns this red",
    (_id, change) => {
      const schema = responseSchemaOf(document, change);
      expect(schema, `${change.assert.operation} is missing from the generated document`).toBeDefined();
      expect(Object.keys((schema as { properties?: object }).properties ?? {}).sort()).toEqual(
        [...change.assert.response_properties].sort(),
      );
    },
  );

  it.each(record.changes.map((change) => [change.id, change] as const))(
    "%s is also carried by the previous-minor baseline, so the N-1 gate compares like with like",
    (_id, change) => {
      const schema = responseSchemaOf(baseline, change);
      expect(schema, `${change.assert.operation} is missing from the previous-minor baseline`).toBeDefined();
      expect(Object.keys((schema as { properties?: object }).properties ?? {}).sort()).toEqual(
        [...change.assert.response_properties].sort(),
      );
    },
  );
});
