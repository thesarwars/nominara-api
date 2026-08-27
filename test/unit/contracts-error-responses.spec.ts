import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { problemDetailsSchema } from "../../contracts/common/problem-details.schema.js";
import { generateClient, generateOpenApiDocument } from "../../src/contracts/generate.js";
import { deriveSemverBump, type OpenApiDocumentLike } from "../../src/contracts/diff.js";
import { applyFakeApiEnv } from "../support/fake-env.js";
import { responseJsonSchema, withoutSchemaMarker } from "../support/json-schema.js";

// STORY-119 · test scenario 8 — "The published client | Can type a `500`
// response".
//
// The taxonomy member landed with the rest of this story; what did not is
// the BODY SHAPE. buildOperation() emitted the success status only, so the
// generated document carried no error responses for any route and
// openapi-typescript had nothing to render. `@nominara/client` therefore
// shipped the error-code union with no body attached to any operation:
// every consumer's error handling was written against a shape the published
// document does not contain — which is precisely what this story's
// Dependencies section says is true "until it lands".
//
// PROBLEM+JSON, not application/json. api-specification.md §1/§2 serve every
// error as `application/problem+json; charset=utf-8`, and a client that
// branches on content type must see the same thing the server sends.
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PROBLEM_MEDIA_TYPE = "application/problem+json";

function readGeneratedFilesText(dir: string): string {
  return readdirSync(dir)
    .filter((name) => statSync(join(dir, name)).isFile())
    .map((name) => readFileSync(join(dir, name), "utf8"))
    .join("\n");
}

describe("STORY-119 · scenario 8 — the document carries the error body, so the client can type a 500", () => {
  const originalEnv = { ...process.env };
  let tempClientDir: string | undefined;

  beforeEach(() => {
    applyFakeApiEnv();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    if (tempClientDir !== undefined) {
      rmSync(tempClientDir, { recursive: true, force: true });
      tempClientDir = undefined;
    }
  });

  /** Every (path, method, operation) triple in the live document. */
  async function operations(): Promise<Array<{ where: string; operation: { responses: Record<string, unknown> } }>> {
    const document = await generateOpenApiDocument();
    const found: Array<{ where: string; operation: { responses: Record<string, unknown> } }> = [];
    for (const [path, methods] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        found.push({ where: `${method.toUpperCase()} ${path}`, operation });
      }
    }
    return found;
  }

  it("there are operations to assert about, so an empty document cannot pass the rest of this file", async () => {
    expect((await operations()).length).toBeGreaterThan(0);
  });

  // A 500 is reachable on EVERY route — an unexpected exception is not a
  // per-endpoint condition — so this is asserted across all of them rather
  // than sampled.
  it("every operation declares a 500 whose body is the published problem-details shape", async () => {
    const expected = withoutSchemaMarker(responseJsonSchema(problemDetailsSchema));
    const missing: string[] = [];
    const wrongShape: string[] = [];

    for (const { where, operation } of await operations()) {
      const response = operation.responses["500"] as
        | { content?: Record<string, { schema: Record<string, unknown> }> }
        | undefined;
      const schema = response?.content?.[PROBLEM_MEDIA_TYPE]?.schema;
      if (schema === undefined) {
        missing.push(where);
        continue;
      }
      if (JSON.stringify(withoutSchemaMarker(schema)) !== JSON.stringify(expected)) wrongShape.push(where);
    }

    expect(missing, `operations with no 500 ${PROBLEM_MEDIA_TYPE} response`).toEqual([]);
    expect(wrongShape, "operations whose 500 body is not problemDetailsSchema").toEqual([]);
  });

  // `default` covers every other error status without this generator
  // inventing a per-route list of which ones a given guard chain can
  // produce. Claiming that precision would be a guess; claiming the SHAPE is
  // not, because the filter gives every error the same one.
  it("every operation declares a default error response of the same shape", async () => {
    const missing: string[] = [];
    for (const { where, operation } of await operations()) {
      const response = operation.responses["default"] as
        | { content?: Record<string, { schema: Record<string, unknown> }> }
        | undefined;
      if (response?.content?.[PROBLEM_MEDIA_TYPE]?.schema === undefined) missing.push(where);
    }
    expect(missing, `operations with no default ${PROBLEM_MEDIA_TYPE} response`).toEqual([]);
  });

  // The point of typing the body at all: a client narrows on `error.code`.
  // If the emitted schema lost the union, the body would be typed and still
  // useless.
  it("the 500 body carries the error-code union, including the unmodelled-failure member", async () => {
    const [first] = await operations();
    const response = first!.operation.responses["500"] as {
      content: Record<string, { schema: Record<string, unknown> }>;
    };
    const schema = response.content[PROBLEM_MEDIA_TYPE]!.schema as {
      properties: { error: { properties: { code: { enum: string[] } } } };
    };
    expect(schema.properties.error.properties.code.enum).toContain("internal_error");
  });

  it("the generated client's output carries the problem-details body for a 500", async () => {
    const document = await generateOpenApiDocument();
    tempClientDir = mkdtempSync(resolve(REPO_ROOT, "node_modules/.tmp-story119-error-responses-client-"));
    await generateClient(document, tempClientDir);

    const output = readGeneratedFilesText(tempClientDir);
    expect(output, "the client must describe the error media type the server actually sends").toContain(
      PROBLEM_MEDIA_TYPE,
    );
    expect(output, "the client must describe the 500 response").toMatch(/\b500\b/);
  });

  // EPIC-03's acceptance criterion: "patch for additive fields, minor for new
  // endpoints, major for any removal or type narrowing." Describing an error
  // body that was previously undescribed takes nothing away from a consumer,
  // so publishing this change must not force a major.
  it("adding the error responses to every operation is a patch, not a break", async () => {
    const current = (await generateOpenApiDocument()) as unknown as OpenApiDocumentLike;
    const previous = JSON.parse(JSON.stringify(current)) as OpenApiDocumentLike;
    for (const methods of Object.values(previous.paths)) {
      for (const operation of Object.values(methods)) {
        delete operation!.responses["500"];
        delete operation!.responses["default"];
      }
    }

    expect(deriveSemverBump(previous, current)).toBe("patch");
  });

  // The generator and the differ are two halves of one gate. Emitting error
  // responses the differ cannot see would publish a NARROWING of the error
  // body as `none` — the document and the client drifting apart with the
  // drift gate reporting clean, which is the exact failure this story's
  // technical notes warn about one level up.
  it("the semver differ is not blind to problem+json — narrowing the error body is major", () => {
    const withCodes = (codes: string[]): OpenApiDocumentLike => ({
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {
        "/v1/thing": {
          get: {
            operationId: "getThing",
            responses: {
              "500": {
                content: {
                  [PROBLEM_MEDIA_TYPE]: {
                    schema: {
                      type: "object",
                      properties: { code: { type: "string", enum: codes } },
                      required: ["code"],
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    expect(
      deriveSemverBump(withCodes(["internal_error", "degraded"]), withCodes(["internal_error"])),
      "dropping a member from the error union a client switches on is a breaking change",
    ).toBe("major");
  });
});
