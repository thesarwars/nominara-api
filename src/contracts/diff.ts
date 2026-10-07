import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// STORY-023 T3 (GREEN step) — AC5 / NFR-REPO-02: "Merging to `main`
// publishes `@nominara/client` at a semver derived from the spec diff:
// patch for additive fields, minor for new endpoints, major for any
// removal or type narrowing." `deriveSemverBump()` is a PURE function over
// two already-generated OpenAPI documents — it never re-derives anything
// from zod itself, and never reaches for the filesystem; `check.ts`/a
// future release job supplies both documents.
//
// The types below describe "whatever shape a generated OpenAPI document
// happens to have" for THIS module's own purposes only — not a zod-backed
// wire DTO (coding-standards.md §2's rule is about request/response
// payloads a client sends/receives; an OpenAPI document is this build
// tool's own internal artifact, with no zod schema of its own to derive
// from). Exported so contracts-semver-diff.spec.ts can import the SAME
// type this function actually accepts instead of re-declaring an
// independent copy of it.
export type SemverBump = "major" | "minor" | "patch" | "none";

export interface JsonSchemaObjectLike {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: unknown;
  enum?: unknown[];
  [key: string]: unknown;
}

export interface OperationLike {
  operationId: string;
  requestBody?: { content: { "application/json": { schema: JsonSchemaObjectLike } } };
  // Keyed by media type. Pinned to "application/json" until STORY-119, which
  // meant the walk below could not see `application/problem+json` at all —
  // so once error responses existed, NARROWING the published error body
  // (dropping a member from the code union a client switches on) classified
  // as `none`. A breaking change published as a patch, with the drift gate
  // reporting clean.
  responses: Record<string, { content?: Record<string, { schema: JsonSchemaObjectLike }> }>;
}

export interface OpenApiDocumentLike {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, Partial<Record<"get" | "post" | "patch" | "put" | "delete", OperationLike>>>;
}

const SEVERITY_RANK: Record<SemverBump, number> = { none: 0, patch: 1, minor: 2, major: 3 };

function mostSevere(a: SemverBump, b: SemverBump): SemverBump {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

function isEnumSubset(narrower: unknown[], wider: unknown[]): boolean {
  return narrower.every((value) => wider.includes(value));
}

/**
 * One SHARED field present in both `previous` and `current`. Any other
 * structural difference this function does not specifically recognise as a
 * safe widening (enum growing, or a field moving from required to
 * optional) is treated as `major` — AC5/the story's own Technical Notes are
 * explicit that a narrowing bump applies "even when it feels harmless";
 * under-reporting a break is the failure mode this differ exists to
 * prevent, so an unrecognised change defaults to the conservative answer.
 */
function compareSharedField(previous: JsonSchemaObjectLike, current: JsonSchemaObjectLike): SemverBump {
  if (JSON.stringify(previous) === JSON.stringify(current)) return "none";

  const nested = compareNestedShape(previous, current);
  if (nested !== undefined) return nested;

  if (previous.type !== undefined && current.type !== undefined && previous.type !== current.type) {
    return "major";
  }

  const previousEnum = previous.enum;
  const currentEnum = current.enum;
  if (previousEnum && currentEnum) {
    if (isEnumSubset(currentEnum, previousEnum) && currentEnum.length < previousEnum.length) return "major"; // fewer values accepted
    if (isEnumSubset(previousEnum, currentEnum)) return "patch"; // same or more values accepted
    return "major"; // neither a subset nor superset — the allowed set itself narrowed
  }
  if (!previousEnum && currentEnum) return "major"; // "any value" -> "one of a fixed set"
  if (previousEnum && !currentEnum) return "patch"; // a fixed set -> "any value"

  return "major";
}

function without(schema: JsonSchemaObjectLike, keys: readonly string[]): string {
  const sorted = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sorted);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([key, inner]) => [key, sorted(inner)]),
      );
    }
    return value;
  };
  return JSON.stringify(sorted(Object.fromEntries(Object.entries(schema).filter(([key]) => !keys.includes(key)))));
}

/**
 * NEW-A-5 option A. A shared field whose schema is an OBJECT (compared on
 * its `properties`/`required`) or an ARRAY (compared on its `items`) is
 * walked into, so one optional field added inside a nested response object
 * is not rated like a type change. The walk only applies when everything
 * ELSE about the node is identical (`type`, `maxItems`, `additionalProperties`,
 * ...): a constraint that moved beside the part being recursed still falls
 * through to the conservative `major`. `undefined` = not a nested shape this
 * function can reason about.
 */
function compareNestedShape(previous: JsonSchemaObjectLike, current: JsonSchemaObjectLike): SemverBump | undefined {
  if (previous.type === "object" && current.type === "object") {
    if (without(previous, ["properties", "required"]) !== without(current, ["properties", "required"])) return undefined;
    return compareObjectSchema(previous, current, true);
  }
  if (previous.type === "array" && current.type === "array") {
    const previousItems = previous.items as JsonSchemaObjectLike | undefined;
    const currentItems = current.items as JsonSchemaObjectLike | undefined;
    if (!previousItems || !currentItems) return undefined;
    if (without(previous, ["items"]) !== without(current, ["items"])) return undefined;
    return compareSharedField(previousItems, currentItems);
  }
  return undefined;
}

/** `properties`/`required` diff shared by a request body schema and a response schema alike. */
function compareObjectSchema(
  previous: JsonSchemaObjectLike | undefined,
  current: JsonSchemaObjectLike | undefined,
  nested = false,
): SemverBump {
  if (!previous && !current) return "none";
  if (!previous && current) return "patch"; // a schema appearing where there was none before
  if (previous && !current) return "major"; // a schema disappearing entirely

  const previousProps = previous!.properties ?? {};
  const currentProps = current!.properties ?? {};
  const previousRequired = new Set(previous!.required ?? []);
  const currentRequired = new Set(current!.required ?? []);
  const fieldNames = new Set([...Object.keys(previousProps), ...Object.keys(currentProps)]);

  let bump: SemverBump = "none";
  for (const name of fieldNames) {
    const inPrevious = name in previousProps;
    const inCurrent = name in currentProps;

    if (inPrevious && !inCurrent) {
      bump = mostSevere(bump, "major"); // field removed
      continue;
    }
    if (!inPrevious && inCurrent) {
      // field added: required is breaking; optional is `patch` at the top of a
      // body and `minor` anywhere nested (owner decision, NEW-A-5 option A).
      bump = mostSevere(bump, currentRequired.has(name) ? "major" : nested ? "minor" : "patch");
      continue;
    }

    // Present on both sides.
    const wasRequired = previousRequired.has(name);
    const isRequired = currentRequired.has(name);
    if (!wasRequired && isRequired) {
      bump = mostSevere(bump, "major"); // an existing optional field is now mandatory
    } else if (wasRequired && !isRequired) {
      bump = mostSevere(bump, "patch"); // an existing required field is now optional
    }

    bump = mostSevere(
      bump,
      compareSharedField(previousProps[name] as JsonSchemaObjectLike, currentProps[name] as JsonSchemaObjectLike),
    );
  }

  return bump;
}

function responseContentOf(
  operation: OperationLike,
  status: string,
): Record<string, { schema: JsonSchemaObjectLike }> {
  return operation.responses[status]?.content ?? {};
}

function compareOperation(previous: OperationLike, current: OperationLike): SemverBump {
  let bump = compareObjectSchema(
    previous.requestBody?.content["application/json"].schema,
    current.requestBody?.content["application/json"].schema,
  );

  const statuses = new Set([...Object.keys(previous.responses), ...Object.keys(current.responses)]);
  for (const status of statuses) {
    const inPrevious = status in previous.responses;
    const inCurrent = status in current.responses;
    if (inPrevious && !inCurrent) {
      bump = mostSevere(bump, "major"); // a response status a consumer may have relied on disappeared
      continue;
    }
    if (!inPrevious && inCurrent) {
      bump = mostSevere(bump, "patch"); // a new response status is additive
      continue;
    }
    // Every media type this status carries, compared on its own. A success
    // body is application/json and an error body is
    // application/problem+json; comparing only the first would leave the
    // other unwatched.
    const previousContent = responseContentOf(previous, status);
    const currentContent = responseContentOf(current, status);
    for (const mediaType of new Set([...Object.keys(previousContent), ...Object.keys(currentContent)])) {
      const previousSchema = previousContent[mediaType]?.schema;
      const currentSchema = currentContent[mediaType]?.schema;
      if (previousSchema !== undefined && currentSchema === undefined) {
        bump = mostSevere(bump, "major"); // a body shape a consumer parsed disappeared
        continue;
      }
      if (previousSchema === undefined && currentSchema !== undefined) {
        bump = mostSevere(bump, "patch"); // a newly described body is additive
        continue;
      }
      bump = mostSevere(bump, compareObjectSchema(previousSchema, currentSchema));
    }
  }

  return bump;
}

/**
 * AC5/NFR-REPO-02 — patch for additive fields, minor for new endpoints,
 * major for any removal or type narrowing. The MOST SEVERE change across
 * every path/method/field wins; nothing here reports "the last change it
 * happened to look at" (the whole reason this walk always takes the
 * running max rather than returning early).
 */
export function deriveSemverBump(previous: OpenApiDocumentLike, current: OpenApiDocumentLike): SemverBump {
  let bump: SemverBump = "none";
  const paths = new Set([...Object.keys(previous.paths), ...Object.keys(current.paths)]);

  for (const path of paths) {
    const previousMethods = previous.paths[path];
    const currentMethods = current.paths[path];

    if (previousMethods && !currentMethods) {
      bump = mostSevere(bump, "major"); // the whole endpoint disappeared
      continue;
    }
    if (!previousMethods && currentMethods) {
      bump = mostSevere(bump, "minor"); // a brand new endpoint
      continue;
    }

    const previousMethodMap = previousMethods as Record<string, OperationLike>;
    const currentMethodMap = currentMethods as Record<string, OperationLike>;
    const methods = new Set([...Object.keys(previousMethodMap), ...Object.keys(currentMethodMap)]);

    for (const method of methods) {
      const previousOperation = previousMethodMap[method];
      const currentOperation = currentMethodMap[method];

      if (previousOperation && !currentOperation) {
        bump = mostSevere(bump, "major"); // one method removed from a path that still has others
        continue;
      }
      if (!previousOperation && currentOperation) {
        bump = mostSevere(bump, "minor"); // a new method added to an existing path
        continue;
      }
      if (previousOperation && currentOperation) {
        bump = mostSevere(bump, compareOperation(previousOperation, currentOperation));
      }
    }
  }

  return bump;
}

// CLI wrapper — `pnpm contracts:diff <previous.json> <current.json>` prints
// the derived bump on stdout (consumed by a future release job per
// NFR-REPO-02's "Automated release job" mechanism; not exercised by any
// test in this task's scope, which imports `deriveSemverBump` as a pure
// function directly). Same `tsx <file>.ts` positional-argv shape as
// check.ts.
async function main(): Promise<void> {
  const [previousPath, currentPath] = process.argv.slice(2);
  if (!previousPath || !currentPath) {
    console.error("usage: pnpm contracts:diff <previous.json> <current.json>");
    process.exit(1);
  }
  const previous = JSON.parse(readFileSync(previousPath, "utf8")) as OpenApiDocumentLike;
  const current = JSON.parse(readFileSync(currentPath, "utf8")) as OpenApiDocumentLike;
  console.log(deriveSemverBump(previous, current));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
