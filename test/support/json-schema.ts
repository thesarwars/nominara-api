import { z } from "zod";
import type { ZodType } from "zod";

// STORY-023 T2 (RED step) — shared JSON-Schema-emission helpers for the
// contract-pipeline spec files.
//
// zod 4.4.3's `z.toJSONSchema()` needs `io` pinned explicitly. Omitting it
// defaults to `io: "output"`, which marks every `.default()`-carrying field
// `required` — verified against paginationRequestSchema:
//   io: "input"           -> properties.limit {default:50}                  (limit NOT required)
//   io: "output" / omitted -> properties.limit {default:50}, required:["limit"]
// Publishing the OUTPUT shape on a REQUEST schema would force every list
// caller to send `limit`, contradicting NFR-API-03's "hard cap 200 and a
// DEFAULT of 50". The rule task T3 must follow, and does here: `io: "input"`
// for every request-side emission (request body, query, path params),
// `io: "output"` for every response-side emission.
export const REQUEST_JSON_SCHEMA_OPTIONS = { target: "draft-2020-12", io: "input" } as const;
export const RESPONSE_JSON_SCHEMA_OPTIONS = { target: "draft-2020-12", io: "output" } as const;

export function requestJsonSchema(schema: ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, REQUEST_JSON_SCHEMA_OPTIONS) as Record<string, unknown>;
}

export function responseJsonSchema(schema: ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, RESPONSE_JSON_SCHEMA_OPTIONS) as Record<string, unknown>;
}

// `z.toJSONSchema()` stamps a top-level `$schema` marker that an embedded
// OpenAPI schema node would not reasonably repeat on every node — excluded
// so a comparison pins the SCHEMA SHAPE (properties/required/
// additionalProperties), never that marker's presence.
export function withoutSchemaMarker(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _marker, ...rest } = schema;
  return rest;
}

export interface JsonSchemaNode {
  type?: string;
  properties?: Record<string, JsonSchemaNode>;
  additionalProperties?: unknown;
  anyOf?: JsonSchemaNode[];
  oneOf?: JsonSchemaNode[];
  $ref?: string;
  [key: string]: unknown;
}

export interface OpenApiDocumentLike {
  components?: { schemas?: Record<string, JsonSchemaNode> };
  [key: string]: unknown;
}

/**
 * Resolves a `{"$ref": "#/components/schemas/Foo"}` node against `document`.
 * Generators commonly hoist named schemas into `components/schemas` and
 * leave a bare `$ref` at the request-body/response/parameter site, which
 * has no `type`, `properties`, or `anyOf` of its own — a walk that does not
 * resolve `$ref` silently records nothing for every hoisted operation.
 * Standard JSON Pointer resolution (split on "/", strip the leading "#"),
 * deliberately generic over whatever key-naming convention the generator
 * picks. Recurses in case a `$ref` points at another `$ref`.
 */
export function resolveJsonSchemaRef(node: JsonSchemaNode, document: OpenApiDocumentLike): JsonSchemaNode {
  if (!node.$ref) return node;
  const pointer = node.$ref.replace(/^#\//, "").split("/");
  let cursor: unknown = document;
  for (const segment of pointer) {
    if (cursor === null || typeof cursor !== "object") {
      throw new Error(`Cannot resolve $ref "${node.$ref}" against the document — segment "${segment}" missing.`);
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return resolveJsonSchemaRef(cursor as JsonSchemaNode, document);
}

export interface StrictnessWalkResult {
  /** Every object-typed (named-field) schema node this walk actually evaluated (after $ref resolution). */
  checkedLabels: string[];
  /** The subset of `checkedLabels` that do NOT emit `additionalProperties: false`. */
  violations: string[];
}

/**
 * Only a node that is `type: "object"` AND carries a `properties` key is a
 * "strict object" candidate — a `z.record` also emits `type: "object"` but
 * with NO `properties` key and a non-boolean `additionalProperties` (see
 * test/unit/contracts-strictness.spec.ts PART A). An `anyOf`/`oneOf` union
 * is unwrapped one level, each branch evaluated the same way. `$ref` is
 * resolved before either check. Deliberately does NOT recurse into a
 * resolved object's OWN nested `properties` values (e.g. a WebAuthn
 * ceremony sub-object embedded inside a request schema) — this is about
 * the REQUEST/PARAMETER schema itself being strict, not every third-
 * party-shaped substructure nested arbitrarily deep inside it.
 */
export function walkSchemaStrictness(
  node: JsonSchemaNode,
  label: string,
  document: OpenApiDocumentLike,
  result: StrictnessWalkResult,
): void {
  const resolved = resolveJsonSchemaRef(node, document);
  const branches = resolved.anyOf ?? resolved.oneOf;
  if (branches) {
    branches.forEach((branch, index) => walkSchemaStrictness(branch, `${label}[anyOf ${index}]`, document, result));
    return;
  }
  if (resolved.type === "object" && resolved.properties) {
    result.checkedLabels.push(label);
    if (resolved.additionalProperties !== false) {
      result.violations.push(label);
    }
  }
}
