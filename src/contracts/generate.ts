import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import openapiTS, { astToString } from "openapi-typescript";
import { z, type ZodType } from "zod";
import { errorCodeSchema } from "../../contracts/common/error-code.schema.js";
import { envelopeSchema } from "../../contracts/common/envelope.schema.js";
import {
  PAGINATION_LIMIT_DEFAULT,
  PAGINATION_LIMIT_MAX,
} from "../../contracts/common/pagination.schema.js";
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

export interface OpenApiParameter {
  readonly name: string;
  readonly in: "query" | "path" | "header";
  readonly required: boolean;
  readonly schema: Record<string, unknown>;
}

export interface OpenApiResponseHeader {
  readonly required: boolean;
  readonly schema: Record<string, unknown>;
}

export interface OpenApiResponse {
  readonly description: string;
  readonly content?: { readonly "application/json": { readonly schema: Record<string, unknown> } };
  headers?: Record<string, OpenApiResponseHeader>;
}

export interface OpenApiOperation {
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
export function buildParameters(schema: ZodType, location: "query" | "path", fullPath: string): OpenApiParameter[] {
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

/**
 * STORY-024 T11 — the schema of the body the server ACTUALLY sends.
 *
 * `@ApiContract({ responseSchema })` names the resource representation. Since
 * T10 that is not what crosses the wire: ResponseEnvelopeInterceptor wraps
 * every non-exempt response in api-specification.md §1's envelope. The
 * document generated before this change described the unwrapped
 * representation for every single route — so `@nominara/client`, whose types
 * come from this document, typed `createWorkspace()` as returning a
 * `Workspace` while the server returned `{data: Workspace, meta: {...}}`.
 * Every property access in a generated consumer would have been undefined at
 * runtime, and `contracts:check` reported the document as clean throughout,
 * because it compares generated-against-committed and BOTH sides carried the
 * same omission. A drift gate cannot catch a defect upstream of the drift.
 *
 * Three cases, matching the interceptor exactly:
 *   exempt          `@NoEnvelope()` (the health probes) — the bare schema.
 *   no responseSchema  a `Promise<void>` handler. The interceptor still
 *                   envelopes it and emits `data: null` explicitly rather
 *                   than dropping the member, so the document says so too:
 *                   these routes DO have a response body.
 *   otherwise       the representation, enveloped.
 *
 * `pagination` is emitted only for a `listOf` operation. envelopeSchema()
 * marks the member optional so a single-resource response would still
 * validate, but advertising a member that can never appear is a contract a
 * consumer has to write dead branches against.
 */
function responseSchemaFor(route: DiscoveredContractRoute): ZodType {
  const contract = route.contract!;

  // A missing `responseSchema` is an ABSENCE OF INFORMATION, never evidence
  // that the route returns nothing. Inferring `z.null()` from it is what
  // published `data: {"type":"null"}` for three routes that return a body.
  // The author declares `voidResponse: true` or supplies a schema; the
  // generator does not guess, and this fails the BUILD rather than a test.
  if (contract.responseSchema === undefined && contract.voidResponse !== true) {
    throw new Error(
      `contracts:generate — route "${contract.operationId}" declares neither a responseSchema nor ` +
        "voidResponse: true, so its response body cannot be described. Add the schema, or declare " +
        "voidResponse: true if the handler really returns Promise<void>. The generator will not infer " +
        "one from the other.",
    );
  }
  if (contract.responseSchema !== undefined && contract.voidResponse === true) {
    throw new Error(
      `contracts:generate — route "${contract.operationId}" declares BOTH a responseSchema and ` +
        "voidResponse: true. It cannot be both; one of the two is wrong.",
    );
  }

  if (route.envelopeExempt) {
    if (contract.responseSchema === undefined) {
      throw new Error(
        `contracts:generate — route "${contract.operationId}" is @NoEnvelope() and returns no body, ` +
          "so it has no describable response at all. Give it a responseSchema or remove the exemption.",
      );
    }
    return contract.responseSchema;
  }

  const enveloped = envelopeSchema(contract.responseSchema ?? z.null());
  return contract.listOf === true ? enveloped : enveloped.omit({ pagination: true });
}

// STORY-024 T11 — AC6: "Pagination is cursor-based … Offset pagination
// exists on no time-series endpoint." api-specification.md §1 is stronger
// still: offset pagination "is not offered on ANY endpoint".
//
// No list endpoint exists yet, so AC6 would otherwise be vacuously true —
// satisfied today by the absence of the thing it governs and quietly
// violated by whichever story ships the first list route. These two checks
// run inside `contracts:generate`, so they fail the BUILD (and with it
// `contracts:check`), not merely a test someone can be tempted to skip.
//
// Exactly the four names test/unit/cursor.spec.ts already refuses on the
// request schema, so the parameter-level and schema-level rules cannot
// drift apart into two different definitions of "offset pagination".
const OFFSET_PAGINATION_PARAMETER_NAMES = new Set(["offset", "page", "page_number", "skip"]);

export function assertNoOffsetPagination(route: DiscoveredContractRoute, operation: OpenApiOperation): void {
  const operationId = route.contract!.operationId;

  const declared = [
    ...(operation.parameters ?? []).map((parameter) => parameter.name),
    ...Object.keys(
      (operation.requestBody?.content["application/json"].schema as JsonSchemaObject | undefined)?.properties ?? {},
    ),
  ];
  for (const name of declared) {
    if (OFFSET_PAGINATION_PARAMETER_NAMES.has(name)) {
      throw new Error(
        `contracts:generate — operation "${operationId}" declares "${name}", which is offset pagination. ` +
          "api-specification.md §1 offers it on no endpoint; page with an opaque cursor " +
          "(src/api/pagination/cursor.ts) and paginationRequestSchema instead.",
      );
    }
  }

  if (route.contract!.listOf !== true) return;

  // "Uses the cursor helper", expressed as something the CONTRACT can be
  // checked against: a listOf operation must carry paginationRequestSchema's
  // own two fields with its own two bounds. A route that re-derived the
  // numbers, or paginated by some other means, fails here.
  const parametersByName = new Map((operation.parameters ?? []).map((parameter) => [parameter.name, parameter]));
  const limit = parametersByName.get("limit");
  if (!parametersByName.has("cursor") || limit === undefined) {
    throw new Error(
      `contracts:generate — operation "${operationId}" is marked listOf but does not declare both ` +
        "`cursor` and `limit` query parameters. Extend paginationRequestSchema in its querySchema.",
    );
  }
  if (limit.schema.maximum !== PAGINATION_LIMIT_MAX || limit.schema.default !== PAGINATION_LIMIT_DEFAULT) {
    throw new Error(
      `contracts:generate — operation "${operationId}" declares a \`limit\` with ` +
        `maximum=${String(limit.schema.maximum)} default=${String(limit.schema.default)}, not NFR-API-03's ` +
        `cap of ${PAGINATION_LIMIT_MAX} and default of ${PAGINATION_LIMIT_DEFAULT}. ` +
        "Extend paginationRequestSchema rather than re-deriving the bounds.",
    );
  }
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
  // STORY-024 T11 — a REQUIRED request header is as much a part of the
  // contract as a required body field. Omitted, `@nominara/client` would
  // generate a call that this server refuses with 422 every time, and the
  // drift gate would report the document as clean while it did.
  if (contract.requiresIfMatch) {
    parameters.push({
      name: "If-Match",
      in: "header",
      required: true,
      schema: { type: "string" },
    });
  }
  if (parameters.length > 0) operation.parameters = parameters;

  const status = String(route.httpStatus);
  operation.responses[status] = {
    description: `${contract.operationId} response`,
    content: {
      "application/json": { schema: toJsonSchema(responseSchemaFor(route), RESPONSE_JSON_SCHEMA_OPTIONS) },
    },
  };

  if (contract.emitsEntityTag) {
    operation.responses[status]!.headers = {
      ETag: { required: true, schema: { type: "string" } },
    };
  }

  assertNoOffsetPagination(route, operation);
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

// STORY-023 T4 (GREEN step) — AC4: "The typed client is generated with
// request and response types, a fetch client, realtime event types, and the
// error-code union." project-structure.md §6 on `@nominara/client`:
// "Generated, never hand-written." Three emitted modules, in that spirit:
//
//   types.ts   openapi-typescript over the SAME document contracts:check
//              gates — never a second walk of the decorators, so the client
//              cannot describe a route the published specification does not.
//   errors.ts  the error-code union, rendered from errorCodeSchema.options
//              rather than transcribed. The document carries no error
//              responses yet (buildOperation() emits the success status
//              only; problem-details wiring is STORY-024's envelope work),
//              so the union genuinely cannot be read back out of `document`
//              — it is taken from the one zod enum that defines it.
//   index.ts   the fetch client: openapi-fetch's createClient bound to
//              `paths`, which is the whole reason openapi-fetch is a RUNTIME
//              dependency of the published package (§6's third boundary row).
//
// WebSocket event types are STORY-026 task T24's, deliberately absent here
// so that scope does not drift onto this task — AC4 is therefore partially,
// not fully, delivered by this function.
const CLIENT_GENERATED_HEADER = `// GENERATED by "pnpm client:generate" (src/contracts/generate.ts) — DO NOT EDIT.
// Regenerate instead; a hand edit here is a second description of the
// contract and exactly what NFR-REPO-01's drift gate exists to prevent.
`;

function renderErrorCodesModule(): string {
  const members = errorCodeSchema.options.map((code) => `  "${code}",`).join("\n");
  return `${CLIENT_GENERATED_HEADER}
/** Every \`error.code\` the API can return — api-specification.md §2's closed taxonomy. */
export const ERROR_CODES = [
${members}
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Narrows an unknown \`error.code\` off the wire to the union above. */
export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && (ERROR_CODES as readonly string[]).includes(value);
}
`;
}

function renderIndexModule(): string {
  return `${CLIENT_GENERATED_HEADER}
import createClient, { type Client, type ClientOptions } from "openapi-fetch";
import type { paths } from "./types.js";

export type { components, operations, paths, webhooks } from "./types.js";
export { ERROR_CODES, isErrorCode, type ErrorCode } from "./errors.js";

export type NominaraClient = Client<paths>;

/** The typed fetch client (AC4). \`baseUrl\` should include no version segment — every path already carries "${API_VERSION_PREFIX}". */
export function createNominaraClient(options: ClientOptions): NominaraClient {
  return createClient<paths>(options);
}
`;
}

export async function generateClient(document: OpenApiDocument, outDir: string): Promise<void> {
  // openapiTS accepts an in-memory document object as well as a path/URL,
  // which is what lets both the live document and the committed
  // previous-minor proxy go through this one code path (scenario 9) without
  // either being written to disk first.
  const types = astToString(await openapiTS(document as unknown as Parameters<typeof openapiTS>[0]));

  writeFileSync(join(outDir, "types.ts"), `${CLIENT_GENERATED_HEADER}\n${types}`, "utf8");
  writeFileSync(join(outDir, "errors.ts"), renderErrorCodesModule(), "utf8");
  writeFileSync(join(outDir, "index.ts"), renderIndexModule(), "utf8");
}

async function main(): Promise<void> {
  const document = await generateOpenApiDocument();
  const outPath = resolve(fileURLToPath(new URL("../..", import.meta.url)), "contracts/openapi.generated.json");
  writeFileSync(outPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  console.log(`contracts:generate — wrote ${outPath}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
