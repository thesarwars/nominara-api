import { fileURLToPath } from "node:url";
import { z, type ZodType } from "zod";
import { API_VERSION_PREFIX } from "../api/configure-app.js";
import { discoverContractRoutes, type DiscoveredContractRoute } from "./discover-routes.js";

// STORY-023 T3 (GREEN step) — AC3/NFR-REPO-01: `contracts:generate` walks
// every LIVE `@ApiContract()`-decorated route (discover-routes.ts) and
// produces an OpenAPI 3.1 document from the SAME zod schema objects each
// route's own ZodValidationPipe validates with. ADR-0002: the decorator's
// metadata IS the source; nothing here duplicates a field description.
//
// `target: "draft-2020-12"` — that dialect IS OpenAPI 3.1's schema dialect.
// `io: "input"` for every request-side emission (body/query/path params),
// `io: "output"` for every response-side emission — zod 4.4.3's
// `z.toJSONSchema()` defaults to `io: "output"`, which marks every
// `.default()`-carrying field `required`; publishing that shape on a
// REQUEST schema would force every list caller to send `limit`, contradicting
// NFR-API-03's "hard cap 200 and a default of 50" (verified empirically
// against paginationRequestSchema before writing this file).
const REQUEST_JSON_SCHEMA_OPTIONS = { target: "draft-2020-12", io: "input" } as const;
const RESPONSE_JSON_SCHEMA_OPTIONS = { target: "draft-2020-12", io: "output" } as const;

interface JsonSchemaObject {
  type?: string;
  properties?: Record<string, Record<string, unknown>>;
  required?: string[];
  [key: string]: unknown;
}

interface OpenApiParameter {
  readonly name: string;
  readonly in: "query" | "path";
  readonly required: boolean;
  readonly schema: Record<string, unknown>;
}

interface OpenApiResponse {
  readonly description: string;
  readonly content?: { readonly "application/json": { readonly schema: Record<string, unknown> } };
}

interface OpenApiOperation {
  operationId: string;
  requestBody?: { content: { "application/json": { schema: Record<string, unknown> } } };
  parameters?: OpenApiParameter[];
  responses: Record<string, OpenApiResponse>;
}

// Plain nested `Record<string, ...>` on purpose, not
// `Partial<Record<"get" | "post" | ..., OpenApiOperation>>` — the latter
// makes every `Object.values()`/`Object.entries()` walk over a path's
// method map carry a spurious `| undefined` in its inferred element type
// (each individually-optional literal key), which the RED-step spec files
// that consume this type do not (and, per this task's brief, must not be
// made to) guard against.
export interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, Record<string, OpenApiOperation>>;
  // Index signature — lets test/support/json-schema.ts's resolveJsonSchemaRef()
  // (typed against its own OpenApiDocumentLike) accept a real OpenApiDocument
  // directly, without a second, narrower "document" type only some call
  // sites can pass.
  [key: string]: unknown;
}

// `z.toJSONSchema()` stamps a top-level `$schema` marker on every call —
// reasonable on a schema evaluated standalone, but not something an
// OpenAPI document repeats on every embedded node. Stripped here so the
// COMMITTED document reads like a real OpenAPI document, never asserted by
// its presence anywhere in the pipeline (test/support/json-schema.ts's
// withoutSchemaMarker() strips it again before every comparison regardless).
function toJsonSchema(
  schema: ZodType,
  options: typeof REQUEST_JSON_SCHEMA_OPTIONS | typeof RESPONSE_JSON_SCHEMA_OPTIONS,
): Record<string, unknown> {
  const { $schema: _marker, ...rest } = z.toJSONSchema(schema, options) as Record<string, unknown>;
  return rest;
}

function pathParamNames(fullPath: string): string[] {
  return [...fullPath.matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => match[1]!);
}

/**
 * Decomposes an object-shaped query/path-parameter zod schema into one
 * OpenAPI `parameters[]` entry per field (M3 — a multi-field querySchema,
 * e.g. oauth.controller.ts's oauthCallbackQuerySchema, becomes one entry
 * per field rather than one opaque object parameter). A non-object schema
 * (e.g. oauthProviderSchema, a bare z.enum validating a single `:provider`
 * segment via `@Param("provider", new ZodValidationPipe(...))`) has no
 * field names of its own to decompose — it is mapped onto the route's own
 * single `:param` path placeholder instead.
 */
function buildParameters(schema: ZodType, location: "query" | "path", fullPath: string): OpenApiParameter[] {
  const jsonSchema = toJsonSchema(schema, REQUEST_JSON_SCHEMA_OPTIONS) as JsonSchemaObject;

  if (jsonSchema.type === "object" && jsonSchema.properties) {
    const required = new Set(jsonSchema.required ?? []);
    return Object.entries(jsonSchema.properties).map(([name, fieldSchema]) => ({
      name,
      in: location,
      required: location === "path" ? true : required.has(name),
      schema: fieldSchema,
    }));
  }

  const names = location === "path" ? pathParamNames(fullPath) : [];
  if (location === "path" && names.length === 1) {
    return [{ name: names[0]!, in: "path", required: true, schema: jsonSchema }];
  }

  throw new Error(
    `contracts:generate — cannot derive a parameter name for a non-object ${location} schema on route "${fullPath}". ` +
      "An object-shaped schema (one parameter per field) or a single-:param path route is required.",
  );
}

function buildOperation(route: DiscoveredContractRoute): OpenApiOperation {
  const contract = route.contract!;
  const operation: OpenApiOperation = { operationId: contract.operationId, responses: {} };

  if (contract.requestSchema) {
    operation.requestBody = {
      content: { "application/json": { schema: toJsonSchema(contract.requestSchema, REQUEST_JSON_SCHEMA_OPTIONS) } },
    };
  }

  const parameters: OpenApiParameter[] = [];
  if (contract.paramsSchema) parameters.push(...buildParameters(contract.paramsSchema, "path", route.fullPath));
  if (contract.querySchema) parameters.push(...buildParameters(contract.querySchema, "query", route.fullPath));
  if (parameters.length > 0) operation.parameters = parameters;

  const status = String(route.httpStatus);
  operation.responses[status] = contract.responseSchema
    ? {
        description: `${contract.operationId} response`,
        content: { "application/json": { schema: toJsonSchema(contract.responseSchema, RESPONSE_JSON_SCHEMA_OPTIONS) } },
      }
    : { description: `${contract.operationId} — no response body` };

  return operation;
}

function toOpenApiPath(fullPath: string): string {
  const withBraces = fullPath.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
  return `/${API_VERSION_PREFIX}/${withBraces}`;
}

/**
 * AC3/NFR-REPO-01 — the single generator both `contracts/openapi.generated.json`
 * (this file's own CLI `main()`) and `GET /v1/openapi.json`
 * (src/contracts/serve.ts, indirectly, via the committed file) trace back
 * to. Only routes carrying `@ApiContract()` metadata become an operation —
 * an undecorated route (health probes, or a route that "forgot" the
 * decorator) simply contributes nothing, which is exactly why ADR-0002
 * requires task T2's coverage gate alongside this generator.
 */
export async function generateOpenApiDocument(): Promise<OpenApiDocument> {
  const routes = await discoverContractRoutes();
  const unsortedPaths: OpenApiDocument["paths"] = {};

  for (const route of routes) {
    if (!route.contract) continue;
    const openApiPath = toOpenApiPath(route.fullPath);
    unsortedPaths[openApiPath] = { ...unsortedPaths[openApiPath], [route.httpMethod]: buildOperation(route) };
  }

  // Sorted insertion order — findControllerFiles() already sorts its own
  // walk (discover-routes.ts), but sorting the FINAL path keys too is what
  // actually keeps `contracts/openapi.generated.json` byte-stable across a
  // regeneration on a different machine, independent of anything about how
  // routes happened to be discovered.
  const paths: OpenApiDocument["paths"] = {};
  for (const key of Object.keys(unsortedPaths).sort()) {
    paths[key] = unsortedPaths[key]!;
  }

  return {
    openapi: "3.1.0",
    info: { title: "Nominara API", version: "1.0.0" },
    paths,
  };
}

// STORY-023 task T4's job, deliberately NOT implemented here (scope
// boundary — T3's brief is explicit: "Do NOT write the client generator").
// Exported with the real signature the RED-step spec files already commit
// to (contracts-worked-example.spec.ts, client-previous-minor.spec.ts) so
// converting their dynamic `import()` loaders to literal static imports —
// authorised, and required, by this task — still type-checks; calling it
// throws, which is the correct, expected failure for every assertion that
// depends on it until T4 lands.
export async function generateClient(_document: OpenApiDocument, _outDir: string): Promise<void> {
  throw new Error("generateClient() is not implemented yet — STORY-023 task T4 (the published client generator).");
}

async function main(): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  const document = await generateOpenApiDocument();
  const outPath = resolve(fileURLToPath(new URL("../..", import.meta.url)), "contracts/openapi.generated.json");
  await writeFile(outPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  console.log(`contracts:generate — wrote ${outPath}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
