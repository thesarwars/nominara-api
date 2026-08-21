import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createWorkspaceRequestSchema } from "../../contracts/workspaces/create-workspace-request.schema.js";
import { entitlementOverridesSchema } from "../../contracts/workspaces/entitlement-overrides.schema.js";
import { oauthProviderSchema } from "../../contracts/identity/oauth-provider.schema.js";
import { passkeyVerifyRequestSchema } from "../../contracts/identity/passkey-verify-request.schema.js";
import { discoverRealRoutes, isExemptFromContractCoverage } from "../support/discover-contract-routes.js";
import { applyFakeApiEnv } from "../support/fake-env.js";
import {
  REQUEST_JSON_SCHEMA_OPTIONS,
  type JsonSchemaNode,
  type OpenApiDocumentLike,
  requestJsonSchema,
  type StrictnessWalkResult,
  walkSchemaStrictness,
} from "../support/json-schema.js";

// STORY-023 T2 (RED step) — AC7 ("every request schema is strict; an
// unknown key is a validation failure, never silently ignored") and Test
// scenario 8's document-level half (the HTTP half — "an unknown key to
// POST /v1/workspaces is a 400" — is in
// test/integration/openapi-route-and-strictness.spec.ts).
//
// This file has two parts:
//   PART A — a CHARACTERIZATION of zod 4.4.3's `z.toJSONSchema()` emission
//     on the three named schema-kind exemplars (a z.union, a z.enum, a
//     z.record). TRUE TODAY, independent of anything task T3 builds — it
//     is what makes PART B's schema-kind-aware walk provably correct
//     rather than a guess.
//   PART B — walks the COMMITTED generated document, resolving `$ref`
//     against `components/schemas` and covering request BODY, QUERY, and
//     PATH-PARAMETER schemas alike (coordinator's code-review round 2, B4
//     and M3). Genuinely RED today: nothing has generated
//     `contracts/openapi.generated.json` yet (task T3).
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

describe("STORY-023 · PART A — zod 4.4.3's JSON Schema emission on the three schema-kind exemplars (characterization, true today)", () => {
  it("a plain `.strict()` object emits `additionalProperties: false` directly on the object", () => {
    const schema = z.toJSONSchema(createWorkspaceRequestSchema, REQUEST_JSON_SCHEMA_OPTIONS) as Record<
      string,
      unknown
    >;
    expect(schema.type).toBe("object");
    expect(schema.properties).toBeTruthy();
    expect(schema.additionalProperties).toBe(false);
  });

  it("passkeyVerifyRequestSchema (a z.union) emits `anyOf`, and EACH branch independently carries `additionalProperties: false`", () => {
    const schema = z.toJSONSchema(passkeyVerifyRequestSchema, REQUEST_JSON_SCHEMA_OPTIONS) as {
      anyOf?: Array<Record<string, unknown>>;
    };
    expect(schema.anyOf).toBeDefined();
    expect(schema.anyOf!.length).toBeGreaterThanOrEqual(2);
    for (const branch of schema.anyOf!) {
      expect(branch.type).toBe("object");
      expect(branch.properties).toBeTruthy();
      expect(branch.additionalProperties).toBe(false);
    }
  });

  it("oauthProviderSchema (a z.enum) is not object-shaped at all — no `additionalProperties` key to assert, correctly", () => {
    const schema = z.toJSONSchema(oauthProviderSchema, REQUEST_JSON_SCHEMA_OPTIONS) as Record<string, unknown>;
    expect(schema.type).toBe("string");
    expect(schema.enum).toEqual(["google", "github", "microsoft"]);
    expect(schema.properties).toBeUndefined();
    expect("additionalProperties" in schema).toBe(false);
  });

  it("entitlementOverridesSchema (a z.record) emits `type: object` WITHOUT a `properties` key — `.strict()` is meaningless here", () => {
    const schema = z.toJSONSchema(entitlementOverridesSchema, REQUEST_JSON_SCHEMA_OPTIONS) as Record<string, unknown>;
    expect(schema.type).toBe("object");
    // The defining, load-bearing distinction from a strict named-field
    // object: no `properties` key at all.
    expect(schema.properties).toBeUndefined();
    // `additionalProperties` IS present here, but it is the record's VALUE
    // schema (an object/anyOf describing what a value may be), never the
    // literal boolean `false` — a naive `=== false` check would wrongly
    // flag this schema as a strictness violation.
    expect(schema.additionalProperties).not.toBe(false);
    expect(typeof schema.additionalProperties).toBe("object");
  });
});

interface OperationLike {
  requestBody?: { content?: Record<string, { schema?: JsonSchemaNode }> };
  parameters?: Array<{ name: string; schema?: JsonSchemaNode }>;
}

interface GeneratedDocumentWithComponents extends OpenApiDocumentLike {
  paths?: Record<string, Record<string, OperationLike>>;
}

describe("STORY-023 · PART B — AC7 over the committed contracts/openapi.generated.json, $ref-resolved (genuinely red: the document does not exist yet)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    applyFakeApiEnv();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  // Split into two assertions rather than one merged count, because OpenAPI
  // represents a request BODY and a set of PARAMETERS structurally
  // differently: `requestBody.content[...].schema` is always the ONE whole
  // body schema (a 1:1 mapping to `@ApiContract()`'s `requestSchema`,
  // exact-countable), while `parameters[]` is an array of individually
  // NAMED entries — a generator may reasonably decompose a multi-field
  // `querySchema` object (e.g. oauthCallbackQuerySchema's `code`/`state`/
  // `error`/…) into several `parameters[]` entries, one per field. Treating
  // "one querySchema" as "exactly one parameters[] entry" would assert on
  // that decomposition choice rather than on the requirement.
  it("every request BODY schema in the committed document — including each $ref-resolved anyOf branch — emits additionalProperties: false (exact count)", async () => {
    // The EXPECTED count comes from the live route discovery (the same
    // ground truth contracts-decorator-coverage.spec.ts and contracts-
    // openapi-generate.spec.ts's B1 fix use), never from "however many the
    // walk happened to find" — otherwise an un-resolved $ref silently
    // checking zero of twenty hoisted request schemas would still satisfy
    // a `> 0` sanity floor (coordinator's code-review round 2, B4).
    const routes = await discoverRealRoutes();
    const nonExempt = routes.filter((route) => !isExemptFromContractCoverage(route));
    const routesWithBody = nonExempt.filter((route) => route.contract?.requestSchema);
    expect(routesWithBody.length, "at least one live route must declare a requestSchema").toBeGreaterThan(0);

    // The expected value is the number of object LEAVES walkSchemaStrictness
    // will check, NOT the number of routes. A `z.union` request schema emits
    // one `anyOf` branch per member and the walk descends into each branch,
    // so a 1:1 route-to-label mapping is a category error: two routes today
    // (`POST /auth/passkey/options` and `POST /auth/passkey/verify`) are
    // two-member unions, which is 8 request bodies but 10 checked leaves.
    // PART A characterizes exactly that emission for passkeyVerifyRequest.
    //
    // Counting leaves with the SAME walker over each route's OWN source
    // schema keeps live discovery as the ground truth — B4's requirement
    // holds unchanged, because an un-resolved $ref in the committed document
    // still yields zero leaves for that body and still fails this assertion.
    // It only stops comparing routes against schema nodes. Source schemas
    // are self-contained (no $ref), hence the empty resolution document.
    const emptyDocument: OpenApiDocumentLike = { components: { schemas: {} } };
    const expectedWalk: StrictnessWalkResult = { checkedLabels: [], violations: [] };
    for (const route of routesWithBody) {
      const requestSchema = route.contract?.requestSchema;
      if (!requestSchema) continue;
      walkSchemaStrictness(
        requestJsonSchema(requestSchema) as JsonSchemaNode,
        `${route.contract?.operationId ?? route.fullPath} [body]`,
        emptyDocument,
        expectedWalk,
      );
    }
    const expectedBodyCount = expectedWalk.checkedLabels.length;
    expect(expectedBodyCount, "the source request schemas must yield at least one checkable object leaf").toBeGreaterThan(
      0,
    );

    const documentPath = resolve(REPO_ROOT, "contracts/openapi.generated.json");
    // No committed document exists yet (task T3) — this throws (ENOENT),
    // the expected RED reason for this test.
    const document = JSON.parse(readFileSync(documentPath, "utf8")) as GeneratedDocumentWithComponents;

    const result: StrictnessWalkResult = { checkedLabels: [], violations: [] };
    for (const [path, pathItem] of Object.entries(document.paths ?? {})) {
      for (const [method, operation] of Object.entries(pathItem)) {
        const bodySchema = operation.requestBody?.content?.["application/json"]?.schema;
        if (bodySchema) {
          walkSchemaStrictness(bodySchema, `${method.toUpperCase()} ${path} [body]`, document, result);
        }
      }
    }

    // Exact equality, not `> 0` — a walk that silently skips every $ref'd
    // (hoisted-into-components) schema would otherwise still pass on the
    // one inlined worked example alone.
    expect(result.checkedLabels.length).toBe(expectedBodyCount);
    expect(result.violations).toEqual([]);
  });

  // M3 — AC7 says *every* request schema, and a QUERY contract is a request
  // schema too (oauth.controller.ts:62's oauthCallbackQuerySchema). This
  // does not assert an exact parameters[] COUNT (see the split rationale
  // above); it asserts the two things that actually matter: (1) a route
  // that declares a query/params schema must not have SILENTLY LOST it —
  // `operation.parameters` must be non-empty — and (2) whatever schema IS
  // present there is strict wherever the strictness rule even applies.
  it("every route with a query or path-parameter schema has a non-empty, $ref-resolved, strict `parameters[]` entry in the committed document", async () => {
    const routes = await discoverRealRoutes();
    const nonExempt = routes.filter((route) => !isExemptFromContractCoverage(route));
    const routesWithParamSchemas = nonExempt.filter((route) => route.contract?.querySchema || route.contract?.paramsSchema);
    expect(
      routesWithParamSchemas.length,
      "at least one live route (the OAuth callback) must declare a querySchema or paramsSchema",
    ).toBeGreaterThan(0);

    const documentPath = resolve(REPO_ROOT, "contracts/openapi.generated.json");
    const document = JSON.parse(readFileSync(documentPath, "utf8")) as GeneratedDocumentWithComponents;

    const result: StrictnessWalkResult = { checkedLabels: [], violations: [] };
    const missingParameters: string[] = [];
    for (const route of routesWithParamSchemas) {
      const operationId = route.contract!.operationId;
      let found: { path: string; method: string; operation: OperationLike } | undefined;
      for (const [path, pathItem] of Object.entries(document.paths ?? {})) {
        for (const [method, operation] of Object.entries(pathItem)) {
          if ((operation as { operationId?: string }).operationId === operationId) {
            found = { path, method, operation };
          }
        }
      }
      const parameters = found?.operation.parameters ?? [];
      if (parameters.length === 0) {
        missingParameters.push(`${route.controllerName}.${route.methodName} (operationId ${operationId})`);
        continue;
      }
      for (const parameter of parameters) {
        if (parameter.schema) {
          walkSchemaStrictness(
            parameter.schema,
            `${found!.method.toUpperCase()} ${found!.path} [param:${parameter.name}]`,
            document,
            result,
          );
        }
      }
    }

    expect(missingParameters).toEqual([]);
    expect(result.violations).toEqual([]);
  });
});
