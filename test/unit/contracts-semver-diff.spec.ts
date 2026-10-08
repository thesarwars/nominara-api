import { describe, expect, it } from "vitest";
import { deriveSemverBump, type OpenApiDocumentLike } from "../../src/contracts/diff.js";

// STORY-023 T2 (RED step) — Test scenarios 4-7 (STORY-023.md "Test scenarios
// — write these first"):
//   4  Add a field                -> minor-level publish (owner decision 5: an added optional field is minor at any depth)
//   5  Add an endpoint            -> minor-level publish
//   6  Remove a field             -> major-level publish
//   7  Narrow a type              -> major-level publish
//
// api-specification.md's source (project-structure.md §7 NFR-REPO-02):
// "Merging to `main` publishes `@nominara/client` at a semver derived from
// the spec diff: patch for additive fields, minor for new endpoints, major
// for any removal or type narrowing." STORY-023 AC5 restates it verbatim.
//
// This file exercises `src/contracts/diff.ts` (task T3, does not exist yet
// — deliberately not created by this RED step) against small, self-
// contained, HAND-BUILT OpenAPI-document-shaped fixtures, so these
// assertions are about the SEMVER-DERIVATION RULE itself and never
// entangled with what `contracts:generate` happens to produce from the
// live schemas today. `expect(...).toBe(...)` against the requirement
// (coding-standards.md §11: "No test asserts on the implementation rather
// than the requirement") — never a peek at diff.ts's internals.
//
// STORY-023 T3 (GREEN step) — `deriveSemverBump` is imported directly as a
// literal static import now that `src/contracts/diff.ts` exists (the RED
// step's non-literal loader and the local `JsonSchemaObjectLike`/
// `OperationLike`/`OpenApiDocumentLike`/`SemverBump` types — hand-written
// descriptions of the exact shape `deriveSemverBump` itself now defines and
// exports — are gone; this file imports `OpenApiDocumentLike` from
// diff.ts directly instead of re-declaring an independent copy of it).
function baseDocument(): OpenApiDocumentLike {
  return {
    openapi: "3.1.0",
    info: { title: "Nominara API (fixture)", version: "1.0.0" },
    paths: {
      "/v1/workspaces": {
        post: {
          operationId: "createWorkspace",
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { name: { type: "string" } },
                  required: ["name"],
                  additionalProperties: false,
                },
              },
            },
          },
          responses: {
            "201": {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { id: { type: "string" }, name: { type: "string" } },
                    required: ["id", "name"],
                    additionalProperties: false,
                  },
                },
              },
            },
          },
        },
      },
    },
  };
}

function deepClone<T>(value: T): T {
  return structuredClone(value);
}

describe("STORY-023 · contracts:diff — semver derived from the specification diff (AC5, NFR-REPO-02)", () => {
  it("scenario 4 — adding an OPTIONAL field to an existing request/response schema is a minor-level bump (owner decision 5: one rule at any depth)", async () => {
    const previous = baseDocument();
    const current = deepClone(previous);
    // Additive and optional — current.paths[...].post.requestBody... — NOT
    // added to `required`, so every previously-valid request stays valid.
    current.paths["/v1/workspaces"]!.post!.requestBody!.content["application/json"].schema.properties!.note = {
      type: "string",
    };

    expect(deriveSemverBump(previous, current)).toBe("minor");
  });

  it("scenario 5 — adding a whole new endpoint is a minor-level bump", async () => {
    const previous = baseDocument();
    const current = deepClone(previous);
    current.paths["/v1/projects"] = {
      get: {
        operationId: "listProjects",
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: { type: "object", properties: { data: { type: "array" } }, additionalProperties: false },
              },
            },
          },
        },
      },
    };

    expect(deriveSemverBump(previous, current)).toBe("minor");
  });

  it("scenario 6 — removing a field is a major-level bump, even though the field looked unused", async () => {
    const previous = baseDocument();
    // The response schema in `previous` carries both `id` and `name`;
    // `current` drops `name` — a consumer's existing code may still read it.
    const current = deepClone(previous);
    const responseSchema =
      current.paths["/v1/workspaces"]!.post!.responses["201"]!.content!["application/json"]!.schema;
    delete responseSchema.properties!.name;
    responseSchema.required = (responseSchema.required as string[]).filter((field) => field !== "name");

    expect(deriveSemverBump(previous, current)).toBe("major");
  });

  it("scenario 7 — narrowing a type (an optional field becoming required) is a major-level bump", async () => {
    const previous = baseDocument();
    const current = deepClone(previous);
    // `note` starts optional (patch-safe, per scenario 4). Later requiring
    // it retroactively invalidates every request that used to omit it —
    // that is a narrowing, not an addition, regardless of it also being
    // "a new field" in a naive diff.
    const requestSchema = current.paths["/v1/workspaces"]!.post!.requestBody!.content["application/json"].schema;
    requestSchema.properties!.note = { type: "string" };
    requestSchema.required = ["name", "note"];

    expect(deriveSemverBump(previous, current)).toBe("major");
  });

  it("scenario 7 (second form) — narrowing a field's TYPE (string -> a fixed enum of fewer values) is a major-level bump", async () => {
    const previous = baseDocument();
    const current = deepClone(previous);
    const requestSchema = current.paths["/v1/workspaces"]!.post!.requestBody!.content["application/json"].schema;
    // Previously any string was accepted for `name`; now only two specific
    // values are — every other previously-valid request body is rejected.
    requestSchema.properties!.name = { type: "string", enum: ["Acme", "Globex"] };

    expect(deriveSemverBump(previous, current)).toBe("major");
  });

  it("an unchanged document is `none` — the differ does not manufacture a bump when nothing moved", async () => {
    const previous = baseDocument();
    const current = deepClone(previous);

    expect(deriveSemverBump(previous, current)).toBe("none");
  });

  it("the MOST SEVERE change wins when a diff mixes an addition and a removal — never 'whichever change is detected last'", async () => {
    const previous = baseDocument();
    const current = deepClone(previous);
    const requestSchema = current.paths["/v1/workspaces"]!.post!.requestBody!.content["application/json"].schema;
    // An additive (patch-shaped) field alongside a removal (major-shaped)
    // field, in the SAME diff. A stub that reports "the last field it
    // looked at" would be order-dependent and could report "patch" here;
    // the correct answer is unconditionally "major".
    requestSchema.properties!.note = { type: "string" }; // addition (patch-shaped)
    const responseSchema =
      current.paths["/v1/workspaces"]!.post!.responses["201"]!.content!["application/json"]!.schema;
    delete responseSchema.properties!.name; // removal (major-shaped)
    responseSchema.required = (responseSchema.required as string[]).filter((field) => field !== "name");

    expect(deriveSemverBump(previous, current)).toBe("major");
  });

  // --- B5 (coordinator's code-review round 2) -------------------------------
  // AC5 says "major for ANY removal", but scenario 6 above only ever
  // removes a FIELD inside a path/method both documents still share. A
  // differ written as "for each path/method in `current`, compare it
  // against the same path/method in `previous`" never iterates a path or
  // method that only exists in `previous` — it would report `none` for a
  // whole endpoint disappearing, publishing a patch (or nothing at all)
  // over a change that breaks every consumer of that endpoint. The
  // "new method on an existing path -> minor" case alongside it guards
  // against the mirror-image cheat: an `Object.keys(paths).length`
  // heuristic passes scenario 5 (a brand new PATH) but would miss a new
  // METHOD added to an EXISTING path, since the path-count does not change.

  it("B5 — removing a WHOLE PATH (the endpoint disappears entirely) is a major-level bump", async () => {
    const previous = baseDocument();
    const current = deepClone(previous);
    delete current.paths["/v1/workspaces"];

    expect(deriveSemverBump(previous, current)).toBe("major");
  });

  it("B5 — removing ONE METHOD from a path that retains others is a major-level bump", async () => {
    const previous = baseDocument();
    // Give the shared path a second method so removing one still leaves
    // the path itself present in both documents.
    previous.paths["/v1/workspaces"]!.get = {
      operationId: "listWorkspaces",
      responses: {
        "200": {
          content: {
            "application/json": {
              schema: { type: "object", properties: { data: { type: "array" } }, additionalProperties: false },
            },
          },
        },
      },
    };
    const current = deepClone(previous);
    delete current.paths["/v1/workspaces"]!.get;

    expect(deriveSemverBump(previous, current)).toBe("major");
  });

  it("B5 — adding a NEW METHOD to an EXISTING path is a minor-level bump (an Object.keys(paths).length heuristic would miss this)", async () => {
    const previous = baseDocument();
    const current = deepClone(previous);
    // Same path as `previous` (/v1/workspaces) — path count is UNCHANGED,
    // only the method set at that path grows.
    current.paths["/v1/workspaces"]!.get = {
      operationId: "listWorkspaces",
      responses: {
        "200": {
          content: {
            "application/json": {
              schema: { type: "object", properties: { data: { type: "array" } }, additionalProperties: false },
            },
          },
        },
      },
    };

    expect(deriveSemverBump(previous, current)).toBe("minor");
  });
});

// --- NEW-A-5 Option A (owner) -----------------------------------------------
// Nested object and array-item schemas are RECURSED INTO. Before this, any
// change under a shared property that was not an enum move fell through to
// `major`, so adding one optional field inside a response's nested object
// published a breaking version for a change no client can break on. The
// owner's rule: an ADDED OPTIONAL field is `minor` at ANY depth, the top
// level included (decision 5, 2026-10-08: one rule; scenario 4). Everything breaking stays `major` at depth.
function nestedDocument(): OpenApiDocumentLike {
  return {
    openapi: "3.1.0",
    info: { title: "Nominara API (fixture)", version: "1.0.0" },
    paths: {
      "/v1/scores": {
        get: {
          operationId: "getScores",
          responses: {
            "200": {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      data: {
                        type: "object",
                        properties: {
                          blended: {
                            type: "object",
                            properties: { score: { type: "number" } },
                            required: ["score"],
                            additionalProperties: false,
                          },
                          engines: {
                            type: "array",
                            items: {
                              type: "object",
                              properties: { engine_key: { type: "string" }, label: { type: "string" } },
                              required: ["engine_key", "label"],
                              additionalProperties: false,
                            },
                          },
                        },
                        required: ["blended", "engines"],
                        additionalProperties: false,
                      },
                    },
                    required: ["data"],
                    additionalProperties: false,
                  },
                },
              },
            },
          },
        },
      },
    },
  };
}

type Loose = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function dataSchema(doc: OpenApiDocumentLike): Loose {
  const root = doc.paths["/v1/scores"]!.get!.responses["200"]!.content!["application/json"]!.schema as Loose;
  return root.properties.data as Loose;
}

describe("NEW-A-5 · contracts:diff recurses into nested object and array-item schemas", () => {
  it("NEW-A-5 · a nested object gaining an OPTIONAL field is a minor bump", () => {
    const previous = nestedDocument();
    const current = deepClone(previous);
    dataSchema(current).properties.blended.properties.data_source = { type: "string" };

    expect(deriveSemverBump(previous, current)).toBe("minor");
  });

  it("NEW-A-5 · an array-item schema gaining an OPTIONAL field is a minor bump", () => {
    const previous = nestedDocument();
    const current = deepClone(previous);
    dataSchema(current).properties.engines.items.properties.data_source = { type: "string" };

    expect(deriveSemverBump(previous, current)).toBe("minor");
  });

  it("NEW-A-5 · a new OPTIONAL property on the response body's data object (one level down) is minor, and so is the same at the root (one rule at any depth)", () => {
    const previous = nestedDocument();
    const nested = deepClone(previous);
    dataSchema(nested).properties.blend = { type: "object", properties: {}, additionalProperties: false };
    expect(deriveSemverBump(previous, nested)).toBe("minor");

    const root = deepClone(previous);
    ((root.paths["/v1/scores"]!.get!.responses["200"]!.content!["application/json"]!.schema as Loose).properties as Loose).note = {
      type: "string",
    };
    expect(deriveSemverBump(previous, root)).toBe("minor");
  });

  it("NEW-A-5 · a nested object gaining a REQUIRED field is major", () => {
    const previous = nestedDocument();
    const current = deepClone(previous);
    const blended = dataSchema(current).properties.blended;
    blended.properties.data_source = { type: "string" };
    blended.required = ["score", "data_source"];

    expect(deriveSemverBump(previous, current)).toBe("major");
  });

  it("NEW-A-5 · a field REMOVED from an array-item schema is major", () => {
    const previous = nestedDocument();
    const current = deepClone(previous);
    const items = dataSchema(current).properties.engines.items;
    delete items.properties.label;
    items.required = ["engine_key"];

    expect(deriveSemverBump(previous, current)).toBe("major");
  });

  it("NEW-A-5 · a nested optional field becoming required is major", () => {
    const previous = nestedDocument();
    dataSchema(previous).properties.blended.properties.note = { type: "string" };
    const current = deepClone(previous);
    dataSchema(current).properties.blended.required = ["score", "note"];

    expect(deriveSemverBump(previous, current)).toBe("major");
  });

  it("NEW-A-5 · a nested field's TYPE narrowing is major", () => {
    const previous = nestedDocument();
    const current = deepClone(previous);
    dataSchema(current).properties.blended.properties.score = { type: "string" };

    expect(deriveSemverBump(previous, current)).toBe("major");
  });

  it("NEW-A-5 · a nested required field becoming optional is patch (widening)", () => {
    const previous = nestedDocument();
    const current = deepClone(previous);
    dataSchema(current).properties.blended.required = [];

    expect(deriveSemverBump(previous, current)).toBe("patch");
  });

  it("NEW-A-5 · an array whose own constraint moved (not just its items) is still major", () => {
    const previous = nestedDocument();
    const current = deepClone(previous);
    dataSchema(current).properties.engines.maxItems = 3;

    expect(deriveSemverBump(previous, current)).toBe("major");
  });

  it("NEW-A-5 · a nested change an additive field cannot excuse: the most severe wins", () => {
    const previous = nestedDocument();
    const current = deepClone(previous);
    const items = dataSchema(current).properties.engines.items;
    items.properties.data_source = { type: "string" }; // minor-shaped
    delete dataSchema(current).properties.blended.properties.score; // major-shaped
    dataSchema(current).properties.blended.required = [];

    expect(deriveSemverBump(previous, current)).toBe("major");
  });

  it("NEW-A-5 · a NULLABLE field (anyOf with null) whose enum gains a value is patch, like a bare enum", () => {
    const previous = nestedDocument();
    dataSchema(previous).properties.blended.properties.source = {
      anyOf: [{ type: "string", enum: ["live", "demo"] }, { type: "null" }],
    };
    const current = deepClone(previous);
    dataSchema(current).properties.blended.properties.source = {
      anyOf: [{ type: "string", enum: ["live", "demo", "mixed"] }, { type: "null" }],
    };

    expect(deriveSemverBump(previous, current)).toBe("patch");
  });

  it("NEW-A-5 · a nullable field's enum LOSING a value is major", () => {
    const previous = nestedDocument();
    dataSchema(previous).properties.blended.properties.source = {
      anyOf: [{ type: "string", enum: ["live", "demo", "mixed"] }, { type: "null" }],
    };
    const current = deepClone(previous);
    dataSchema(current).properties.blended.properties.source = {
      anyOf: [{ type: "string", enum: ["live", "demo"] }, { type: "null" }],
    };

    expect(deriveSemverBump(previous, current)).toBe("major");
  });

  it("NEW-A-5 · a field that becomes nullable (a branch appears) stays major", () => {
    const previous = nestedDocument();
    dataSchema(previous).properties.blended.properties.source = { type: "string", enum: ["live", "demo"] };
    const current = deepClone(previous);
    dataSchema(current).properties.blended.properties.source = {
      anyOf: [{ type: "string", enum: ["live", "demo"] }, { type: "null" }],
    };

    expect(deriveSemverBump(previous, current)).toBe("major");
  });

  it("NEW-A-5 · a RECORD (additionalProperties is a schema) whose value enum gains a value is patch", () => {
    const previous = nestedDocument();
    dataSchema(previous).properties.sources = {
      type: "object",
      propertyNames: { type: "string" },
      additionalProperties: { anyOf: [{ type: "string", enum: ["live", "demo"] }, { type: "null" }] },
    };
    const current = deepClone(previous);
    dataSchema(current).properties.sources.additionalProperties.anyOf[0].enum = ["live", "demo", "mixed"];

    expect(deriveSemverBump(previous, current)).toBe("patch");
  });

  it("NEW-A-5 · a record value whose enum LOSES a value, or a closed object that opens up, is major", () => {
    const previous = nestedDocument();
    dataSchema(previous).properties.sources = {
      type: "object",
      propertyNames: { type: "string" },
      additionalProperties: { type: "string", enum: ["live", "demo", "mixed"] },
    };
    const narrowed = deepClone(previous);
    dataSchema(narrowed).properties.sources.additionalProperties.enum = ["live"];
    expect(deriveSemverBump(previous, narrowed)).toBe("major");

    const closed = deepClone(previous);
    dataSchema(closed).properties.sources.additionalProperties = false;
    expect(deriveSemverBump(previous, closed)).toBe("major");
  });

  it("NEW-A-5 · an unchanged nested document is none", () => {
    const previous = nestedDocument();
    expect(deriveSemverBump(previous, deepClone(previous))).toBe("none");
  });
});
