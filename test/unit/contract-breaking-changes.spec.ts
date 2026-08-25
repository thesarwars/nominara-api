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
  readonly previous_minor_baseline_rewritten: boolean;
  readonly assert: {
    readonly operation: string;
    readonly path: string;
    readonly method: string;
    readonly status: string;
    readonly response_properties: string[];
    /** For a change INSIDE `data` — the envelope is unchanged, so top-level properties cannot show it. */
    readonly data_properties?: string[];
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

  // STORY-117 — this assertion USED to demand that the baseline exhibit the
  // same shape as the current document, unconditionally. That is backwards for
  // a breaking change in general: if the two agree, nothing broke. It was
  // written for T11, which rewrote the baseline in the same commit — the very
  // handling this file exists to stop from recurring silently.
  //
  // So the record now says which happened, and this asserts the one it claims:
  //
  //   rewritten: true   the baseline was re-authored to match (T11). The two
  //                     must agree, and the entry is what makes that visible.
  //   rewritten: false  the baseline was LEFT ALONE. The two must therefore
  //                     NOT agree — or the change did not actually break
  //                     anything and the record is describing a fiction.
  //
  // The proxy covers one path (STORY-023 OQ-8: there is no published N-1 to
  // test against), so "absent" is a legitimate form of "does not agree" and is
  // reported as such rather than silently passing.
  it.each(record.changes.map((change) => [change.id, change] as const))(
    "%s stands in the correct relation to the previous-minor baseline",
    (_id, change) => {
      const schema = responseSchemaOf(baseline, change);
      if (change.previous_minor_baseline_rewritten) {
        expect(schema, `${change.assert.operation} is missing from the previous-minor baseline`).toBeDefined();
        expect(Object.keys((schema as { properties?: object }).properties ?? {}).sort()).toEqual(
          [...change.assert.response_properties].sort(),
        );
        return;
      }
      if (schema === undefined) return; // the proxy does not cover this route at all
      expect(
        Object.keys((schema as { properties?: object }).properties ?? {}).sort(),
        `${change.assert.operation} looks IDENTICAL in the previous-minor baseline, so nothing broke — ` +
          "either the record is wrong or the baseline was quietly rewritten",
      ).not.toEqual([...change.assert.response_properties].sort());
    },
  );

  // A change inside `data` leaves the envelope untouched, so the top-level
  // assertion above cannot see it. This one reaches into the payload.
  it.each(
    record.changes.filter((change) => change.assert.data_properties !== undefined).map((c) => [c.id, c] as const),
  )("%s is exhibited by the CURRENT document's data payload", (_id, change) => {
    const schema = responseSchemaOf(document, change) as
      | { properties?: { data?: { properties?: object; items?: { properties?: object } } } }
      | undefined;
    const data = schema?.properties?.data;
    const properties = data?.properties ?? data?.items?.properties ?? {};
    expect(Object.keys(properties).sort()).toEqual([...change.assert.data_properties!].sort());
  });
});
