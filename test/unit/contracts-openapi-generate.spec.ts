import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkspaceRequestSchema } from "../../contracts/workspaces/create-workspace-request.schema.js";
import { generateOpenApiDocument, type OpenApiDocument } from "../../src/contracts/generate.js";
import { discoverRealRoutes, isExemptFromContractCoverage } from "../support/discover-contract-routes.js";
import { applyFakeApiEnv } from "../support/fake-env.js";
import { requestJsonSchema, resolveJsonSchemaRef, withoutSchemaMarker } from "../support/json-schema.js";

// STORY-023 T2 (RED step) — Test scenario 1 ("Generate from the schemas ->
// the committed document matches") and AC3 ("Generation produces a
// committed specification document").
//
// ADR-0002: reading `@ApiContract()`'s metadata off a LIVE route means the
// generator "must either boot the Nest container or walk route metadata via
// DiscoveryService" — so this exercises the real, deployed ApiModule
// (same fake-env pattern src/api/api.module.spec.ts uses), not a stand-in.
//
// Coordinator's code-review round 2, B1: nothing in this file's first
// version tied the generated document's CONTENTS to the discovered route
// set — a document containing exactly one operation satisfied every
// assertion here, and so would `generateOpenApiDocument = () =>
// JSON.parse(readFileSync("contracts/openapi.generated.json"))` (never
// touching the live container at all). ADR-0002's entire premise — that
// the generator walks `@ApiContract()` off the live container — was
// untested. The new test below closes that: it runs the SAME discovery
// walk contracts-decorator-coverage.spec.ts uses and asserts SET EQUALITY
// between "every non-exempt route's operationId" and "every operationId in
// the generated document", then per-route schema equality for every route
// carrying a requestSchema. Same shape as the house precedent
// test/integration/rls-check.spec.ts:92 (introspect the REAL thing,
// compare against the DECLARED expectation, never the other way round).
//
// STORY-023 T3 (GREEN step) — `src/contracts/generate.ts` now exists;
// `generateOpenApiDocument` is imported directly as a literal static
// import (the RED step's non-literal `import()` loader/local
// `GeneratedDocument` interface are gone — that interface was a hand-
// written description of a contract that now lives in generate.ts's own
// exported `OpenApiDocument` type, exactly the duplication AC2 rejects,
// one level up).
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

describe("STORY-023 · contracts:generate — scenario 1: a fresh in-memory generation deep-equals the committed document", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    applyFakeApiEnv();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("scenario 1 — regenerating in memory produces the SAME document as contracts/openapi.generated.json", async () => {
    const generated = await generateOpenApiDocument();

    const committedPath = resolve(REPO_ROOT, "contracts/openapi.generated.json");
    const committed = JSON.parse(readFileSync(committedPath, "utf8")) as OpenApiDocument;

    expect(generated).toEqual(committed);
  });

  it("the generated document is a real OpenAPI 3.1 document — not an empty placeholder a stub could satisfy", async () => {
    const generated = await generateOpenApiDocument();

    expect(generated.openapi).toMatch(/^3\.1\./);
    const workedExampleOperation = generated.paths["/v1/workspaces"]?.post;
    expect(workedExampleOperation?.operationId).toBeTruthy();
  });

  it("the worked example's (POST /v1/workspaces) generated request schema structurally matches createWorkspaceRequestSchema's OWN JSON Schema emission", async () => {
    const generated = await generateOpenApiDocument();

    const requestSchema = generated.paths["/v1/workspaces"]?.post?.requestBody?.content["application/json"].schema;
    const resolved = requestSchema ? resolveJsonSchemaRef(requestSchema, generated) : undefined;

    expect(resolved && withoutSchemaMarker(resolved)).toEqual(
      withoutSchemaMarker(requestJsonSchema(createWorkspaceRequestSchema)),
    );
  });

  // B1 — the generator must reflect the LIVE, DISCOVERED route set, not an
  // arbitrary/partial/hand-authored one. Two halves:
  //   (a) SET EQUALITY of operationIds — the document has neither more nor
  //       fewer operations than there are non-exempt @ApiContract()-
  //       decorated routes.
  //   (b) for every route carrying a requestSchema, the document's
  //       ($ref-resolved) schema for that operationId deep-equals
  //       z.toJSONSchema(requestSchema, {io:"input"}) — proving the
  //       document's CONTENT, not just its operation COUNT, traces back to
  //       the live decorator metadata.
  it("B1 — the generated document's operations are EXACTLY the operationIds of every non-exempt @ApiContract()-decorated route (set equality)", async () => {
    const routes = await discoverRealRoutes();
    const nonExempt = routes.filter((route) => !isExemptFromContractCoverage(route));
    const expectedOperationIds = new Set(
      nonExempt.map((route) => route.contract?.operationId).filter((id): id is string => Boolean(id)),
    );
    expect(expectedOperationIds.size, "at least one live route must declare @ApiContract()").toBeGreaterThan(0);

    const generated = await generateOpenApiDocument();

    const actualOperationIds = new Set<string>();
    for (const pathItem of Object.values(generated.paths ?? {})) {
      for (const operation of Object.values(pathItem)) {
        if (operation.operationId) actualOperationIds.add(operation.operationId);
      }
    }

    expect(actualOperationIds).toEqual(expectedOperationIds);
  });

  it("B1 — for every route carrying a requestSchema, the document's ($ref-resolved) schema for that operationId deep-equals z.toJSONSchema(requestSchema, io: 'input')", async () => {
    const routes = await discoverRealRoutes();
    const nonExempt = routes.filter((route) => !isExemptFromContractCoverage(route));
    const routesWithRequestSchema = nonExempt.filter((route) => route.contract?.requestSchema);
    expect(routesWithRequestSchema.length, "at least one live route must declare a requestSchema").toBeGreaterThan(
      0,
    );

    const generated = await generateOpenApiDocument();

    const operationById = new Map<
      string,
      { path: string; method: string; requestSchema: Record<string, unknown> | undefined }
    >();
    for (const [path, pathItem] of Object.entries(generated.paths ?? {})) {
      for (const [method, operation] of Object.entries(pathItem)) {
        if (operation.operationId) {
          operationById.set(operation.operationId, {
            path,
            method,
            requestSchema: operation.requestBody?.content["application/json"].schema,
          });
        }
      }
    }

    for (const route of routesWithRequestSchema) {
      const operationId = route.contract!.operationId;
      const operation = operationById.get(operationId);
      expect(operation, `operationId "${operationId}" (${route.controllerName}.${route.methodName}) missing from the generated document`).toBeDefined();
      expect(
        operation!.requestSchema,
        `operationId "${operationId}" is missing a requestBody schema in the generated document`,
      ).toBeDefined();

      const resolved = resolveJsonSchemaRef(operation!.requestSchema!, generated);
      const expected = requestJsonSchema(route.contract!.requestSchema!);
      expect(withoutSchemaMarker(resolved)).toEqual(withoutSchemaMarker(expected));
    }
  });
});
