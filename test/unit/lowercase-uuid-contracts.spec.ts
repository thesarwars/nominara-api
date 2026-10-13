import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { lowercaseUuidSchema } from "../../contracts/common/uuid.schema.js";
import { discoverRealRoutes, isExemptFromContractCoverage } from "../support/discover-contract-routes.js";
import { applyFakeApiEnv } from "../support/fake-env.js";

// STORY-150 AC7 — "Body and query uuids are handled systematically". A path param is canonicalised by
// CanonicalParamsGuard; a body or query uuid is seen by no guard, and zod's `.uuid()` ACCEPTS uppercase, so a
// request field kept whatever spelling the client chose (the `prompt_ids` defect, fixed once by hand).
// The class is closed by a shared schema, and by this walk over EVERY request schema a route declares — so a
// 68th uuid field added later with a bare `z.uuid()` fails the build instead of waiting for the next review.

interface ZodNode {
  _zod: { def: Record<string, unknown> };
}

const UPPER = "A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11";
const LOWER = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";

function isNode(value: unknown): value is ZodNode {
  return typeof value === "object" && value !== null && "_zod" in value;
}

function hasUuidFormat(def: Record<string, unknown>): boolean {
  if (def.type === "string" && def.format === "uuid") return true;
  const checks = (def.checks as ZodNode[] | undefined) ?? [];
  return checks.some((check) => check._zod.def.format === "uuid");
}

function hasOverwrite(def: Record<string, unknown>): boolean {
  const checks = (def.checks as ZodNode[] | undefined) ?? [];
  return checks.some((check) => check._zod.def.check === "overwrite");
}

/** Every uuid-typed node reachable from `schema`, with whether it lowercases. */
function uuidNodes(schema: unknown, path: string, out: { path: string; lowercases: boolean }[], seen = new Set<unknown>()): void {
  if (!isNode(schema) || seen.has(schema)) return;
  seen.add(schema);
  const def = schema._zod.def;
  if (def.type === "string" && hasUuidFormat(def)) out.push({ path, lowercases: hasOverwrite(def) });

  const children: [string, unknown][] = [];
  if (def.type === "object") {
    for (const [key, value] of Object.entries(def.shape as Record<string, unknown>)) children.push([`${path}.${key}`, value]);
  }
  for (const key of ["element", "innerType", "left", "right", "in", "out", "keyType", "valueType"]) {
    if (key in def) children.push([`${path}.${key === "element" ? "[]" : key}`, def[key]]);
  }
  for (const key of ["options", "items"]) {
    const list = def[key];
    if (Array.isArray(list)) list.forEach((value, index) => children.push([`${path}|${key}${index}`, value]));
  }
  if (typeof def.getter === "function") children.push([path, (def.getter as () => unknown)()]);
  for (const [childPath, child] of children) uuidNodes(child, childPath, out, seen);
}

describe("STORY-150 AC7 · lowercaseUuidSchema", () => {
  it("STORY-150 AC7 — an uppercase uuid parses to its lowercase spelling", () => {
    expect(lowercaseUuidSchema.parse(UPPER)).toBe(LOWER);
  });

  it("STORY-150 AC7 — an already-canonical uuid is unchanged, and a mixed-case one is lowercased", () => {
    expect(lowercaseUuidSchema.parse(LOWER)).toBe(LOWER);
    expect(lowercaseUuidSchema.parse("A0eEbc99-9C0b-4ef8-Bb6D-6bb9BD380a11")).toBe(LOWER);
  });

  it("STORY-150 AC7 — a spelling Postgres would accept but we will not is still refused (braced, hyphenless, misplaced hyphens)", () => {
    for (const spelling of [`{${LOWER}}`, LOWER.replaceAll("-", ""), "a0ee-bc99-9c0b-4ef8-bb6d-6bb9bd380a11", "not-a-uuid", ""]) {
      expect(lowercaseUuidSchema.safeParse(spelling).success, spelling).toBe(false);
    }
  });

  it("STORY-150 AC7 — the published JSON Schema is the same in both directions and still says format: uuid (no transform artifact)", () => {
    for (const io of ["input", "output"] as const) {
      const json = z.toJSONSchema(lowercaseUuidSchema, { io }) as Record<string, unknown>;
      expect(json.type).toBe("string");
      expect(json.format).toBe("uuid");
    }
  });

  it("STORY-150 AC7 — the walker sees a bare uuid as NOT lowercasing, so the route walk below cannot pass vacuously", () => {
    const found: { path: string; lowercases: boolean }[] = [];
    uuidNodes(z.object({ a: z.uuid(), b: z.array(z.string().uuid()), c: lowercaseUuidSchema.optional() }), "$", found);
    expect(found.map((node) => node.lowercases)).toEqual([false, false, true]);
  });
});

describe("STORY-150 AC7 · every uuid in a request body, query or params schema is lowercased at the boundary", () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    applyFakeApiEnv();
  });
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("STORY-150 AC7 — no route's request, query or params schema carries a uuid that keeps the client's spelling", async () => {
    const routes = (await discoverRealRoutes()).filter((route) => !isExemptFromContractCoverage(route) && route.contract !== undefined);
    const offenders: string[] = [];
    let uuidFields = 0;
    for (const route of routes) {
      for (const slot of ["requestSchema", "querySchema", "paramsSchema"] as const) {
        const nodes: { path: string; lowercases: boolean }[] = [];
        uuidNodes(route.contract![slot], slot, nodes);
        uuidFields += nodes.length;
        for (const node of nodes) if (!node.lowercases) offenders.push(`${route.contract!.operationId} ${node.path}`);
      }
    }
    expect(uuidFields, "the walk must actually find the request uuids, or a pass proves nothing").toBeGreaterThan(10);
    expect(offenders).toEqual([]);
  });
});
