import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// STORY-075b AC3 / NEW-D-1 AC3 (checkpoint-4) — the PUBLISHED contract, not the wire.
//
// A route can send `pagination` on the wire while the published document
// omits it (the route lacked `listOf: true`): a generated @nominara/client
// then cannot read `cursor_next`, and every wire test stays green. So this
// reads contracts/openapi.generated.json itself — the artifact a client is
// generated from — and starts from the hazard: any GET that accepts a
// `cursor` query parameter must publish a REQUIRED `pagination` member.
interface Operation {
  readonly operationId: string;
  readonly parameters?: readonly { readonly name: string }[];
  readonly responses: Record<string, { content?: Record<string, { schema?: { properties?: Record<string, unknown>; required?: string[] } }> }>;
}
const document = JSON.parse(readFileSync(new URL("../../contracts/openapi.generated.json", import.meta.url), "utf8")) as {
  paths: Record<string, { get?: Operation }>;
};
const getOperations = Object.entries(document.paths).flatMap(([path, item]) => (item.get === undefined ? [] : [{ path, op: item.get }]));
const byId = (operationId: string) => {
  const found = getOperations.find(({ op }) => op.operationId === operationId);
  if (found === undefined) throw new Error(`no GET operation ${operationId} in the published document`);
  return found.op;
};
const okSchema = (op: Operation) => op.responses["200"]?.content?.["application/json"]?.schema;
const paramNames = (op: Operation) => (op.parameters ?? []).map((p) => p.name);

describe("published pagination contract", () => {
  it("STORY-075b AC3 · listInvoices publishes a required `pagination` member and the cursor/limit parameters", () => {
    const op = byId("listInvoices");
    expect(paramNames(op)).toEqual(expect.arrayContaining(["cursor", "limit"]));
    expect(Object.keys(okSchema(op)?.properties ?? {})).toContain("pagination");
    expect(okSchema(op)?.required).toContain("pagination");
  });

  it("NEW-D-1 AC3 · listCreditPacks is a cursor list: cursor/limit parameters and a required `pagination` member", () => {
    const op = byId("listCreditPacks");
    expect(paramNames(op)).toEqual(expect.arrayContaining(["cursor", "limit"]));
    expect(okSchema(op)?.required).toContain("pagination");
  });

  it("every GET that accepts a `cursor` publishes a required `pagination` member (sweep from the hazard, no allow-list)", () => {
    const missing = getOperations
      .filter(({ op }) => paramNames(op).includes("cursor"))
      .filter(({ op }) => !(okSchema(op)?.required ?? []).includes("pagination") || okSchema(op)?.properties?.pagination === undefined)
      .map(({ op }) => op.operationId);
    expect(missing).toEqual([]);
  });
});
