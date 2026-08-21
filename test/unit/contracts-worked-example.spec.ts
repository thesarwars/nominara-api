import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { errorCodeSchema } from "../../contracts/common/error-code.schema.js";
import {
  createWorkspaceRequestSchema,
  type CreateWorkspaceRequest,
} from "../../contracts/workspaces/create-workspace-request.schema.js";
import { workspaceResponseSchema, type WorkspaceResponse } from "../../contracts/workspaces/workspace-response.schema.js";
import { generateClient, generateOpenApiDocument, type OpenApiDocument } from "../../src/contracts/generate.js";
import { applyFakeApiEnv } from "../support/fake-env.js";
import { requestJsonSchema, resolveJsonSchemaRef, responseJsonSchema, withoutSchemaMarker } from "../support/json-schema.js";

// STORY-023 T2 (RED step) — Test scenario 10 ("Inspect the worked example ->
// validator, type, specification entry, and client method all present and
// agreeing") and AC9. The worked example is `POST /v1/workspaces`, an
// EXISTING endpoint (STORY-021) — never a new one; inventing a domain
// endpoint here would be out of this epic's scope.
//
// Five sub-describes below: AC9's four artifacts (validator, type,
// specification entry, client method) plus AC4's error-code union (M4),
// which is part of what the SAME "typed client" artifact must carry.
//
// STORY-023 T3 (GREEN step) — `generateOpenApiDocument`/`generateClient` are
// imported directly as literal static imports now that `src/contracts/
// generate.ts` exists (the RED step's non-literal loader and local
// `GeneratedDocument` interface, a hand-written duplicate of generate.ts's
// own exported `OpenApiDocument` type, are both gone). `generateClient()`
// itself is still task T4's job — it throws until then, which is the
// correct, expected failure for "4. client method" and "5. error-code
// union" below.
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** Files only — readFileSync-ing a directory entry throws EISDIR. */
function readGeneratedFilesText(dir: string): string {
  return readdirSync(dir)
    .filter((name) => statSync(join(dir, name)).isFile())
    .map((name) => readFileSync(join(dir, name), "utf8"))
    .join("\n");
}

describe("STORY-023 · scenario 10 — the worked example (POST /v1/workspaces): validator, type, specification entry, and client method agree", () => {
  const originalEnv = { ...process.env };
  let tempClientDir: string | undefined;

  beforeEach(() => {
    applyFakeApiEnv();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    if (tempClientDir) {
      rmSync(tempClientDir, { recursive: true, force: true });
      tempClientDir = undefined;
    }
  });

  // [characterization, permanently green] — createWorkspaceRequestSchema
  // and workspaceResponseSchema are pre-existing STORY-021 schemas, not
  // something task T3 builds. This sub-describe can never turn red because
  // of anything this story's later tasks do; it exists so AC9's "validator"
  // artifact is explicitly accounted for, the same way
  // contracts-strictness.spec.ts's PART A is labelled.
  describe("[characterization, permanently green] 1. validator", () => {
    it("createWorkspaceRequestSchema validates the minimum request and rejects an unknown key", () => {
      expect(createWorkspaceRequestSchema.safeParse({ name: "Acme" }).success).toBe(true);
      expect(createWorkspaceRequestSchema.safeParse({ name: "Acme", mystery: true }).success).toBe(false);
    });

    it("workspaceResponseSchema validates a well-formed response", () => {
      const valid = {
        id: "018f3b3a-0000-7000-8000-000000000001",
        name: "Acme",
        slug: "acme",
        org_type: "in_house",
        region: "us-east-1",
        timezone: "UTC",
        plan_key: "free",
        entitlement_version: 1,
        status: "active",
        created_at: "2026-08-19T00:00:00.000Z",
        updated_at: "2026-08-19T00:00:00.000Z",
      };
      expect(workspaceResponseSchema.safeParse(valid).success).toBe(true);
    });
  });

  // [characterization, permanently green] — see "1. validator" above; this
  // is a `pnpm typecheck`-level check (CreateWorkspaceRequest/
  // WorkspaceResponse are z.infer<> of pre-existing schemas), not something
  // task T3's generator changes.
  describe("[characterization, permanently green] 2. type", () => {
    it("CreateWorkspaceRequest/WorkspaceResponse are z.infer<> of the schemas above — a compile-time check (pnpm typecheck)", () => {
      // No hand-written interface exists anywhere for these — a hand-written
      // request/response interface is a review rejection (coding-standards.md
      // §2). If either type ever drifted from its schema (e.g. a field
      // renamed on one side only), THIS FILE would fail `pnpm typecheck`.
      const requestSample: CreateWorkspaceRequest = { name: "Acme" };
      const responseSample: WorkspaceResponse = {
        id: "018f3b3a-0000-7000-8000-000000000001",
        name: "Acme",
        slug: "acme",
        org_type: "in_house",
        region: "us-east-1",
        timezone: "UTC",
        plan_key: "free",
        entitlement_version: 1,
        status: "active",
        created_at: "2026-08-19T00:00:00.000Z",
        updated_at: "2026-08-19T00:00:00.000Z",
      };

      expect(createWorkspaceRequestSchema.safeParse(requestSample).success).toBe(true);
      expect(workspaceResponseSchema.safeParse(responseSample).success).toBe(true);
    });
  });

  describe("3. specification entry", () => {
    it("the committed document's POST /v1/workspaces entry structurally matches the source schemas ($ref-resolved, io-aware)", () => {
      const documentPath = resolve(REPO_ROOT, "contracts/openapi.generated.json");
      const document = JSON.parse(readFileSync(documentPath, "utf8")) as OpenApiDocument;

      const operation = document.paths["/v1/workspaces"]?.post;
      expect(operation, "POST /v1/workspaces must be present in the generated document").toBeDefined();
      expect(operation!.operationId).toBeTruthy();

      const requestSchema = operation!.requestBody?.content["application/json"].schema;
      expect(requestSchema, "POST /v1/workspaces must have a requestBody schema").toBeDefined();
      expect(withoutSchemaMarker(resolveJsonSchemaRef(requestSchema!, document))).toEqual(
        withoutSchemaMarker(requestJsonSchema(createWorkspaceRequestSchema)),
      );

      // POST /workspaces returns the bare WorkspaceResponse today (STORY-021)
      // — envelope wrapping ({data, pagination, meta}) is STORY-024's job,
      // not retrofitted here, so the specification entry is expected to
      // agree with workspaceResponseSchema directly, unwrapped.
      const responseSchema = operation!.responses["201"]?.content?.["application/json"].schema;
      expect(responseSchema, "POST /v1/workspaces must have a 201 response schema").toBeDefined();
      expect(withoutSchemaMarker(resolveJsonSchemaRef(responseSchema!, document))).toEqual(
        withoutSchemaMarker(responseJsonSchema(workspaceResponseSchema)),
      );
    });
  });

  describe("4. client method", () => {
    it("generating a client from the live document produces output that recognizes POST /v1/workspaces", async () => {
      const document = await generateOpenApiDocument();

      tempClientDir = mkdtempSync(resolve(REPO_ROOT, "node_modules/.tmp-story023-worked-example-client-"));
      await generateClient(document, tempClientDir);

      const writtenFiles = readdirSync(tempClientDir);
      expect(writtenFiles.length, "generateClient() must write at least one file").toBeGreaterThan(0);

      expect(readGeneratedFilesText(tempClientDir)).toContain("/v1/workspaces");
    });
  });

  // M4 — AC4: "The typed client is generated with request and response
  // types, a fetch client, realtime event types, and the error-code union."
  // Compared against errorCodeSchema.options (currently 27 members) —
  // NEVER a hardcoded list, so this test cannot silently go stale the next
  // time §2's taxonomy grows or shrinks by one code.
  //
  // Realtime event types are STORY-026's (task T24) to build and test —
  // deferred, not covered here, so that scope does not silently drift onto
  // this task.
  describe("5. error-code union (AC4)", () => {
    it("the generated client's output contains every one of errorCodeSchema's 27 members", async () => {
      const document = await generateOpenApiDocument();

      tempClientDir = mkdtempSync(resolve(REPO_ROOT, "node_modules/.tmp-story023-error-code-client-"));
      await generateClient(document, tempClientDir);

      const combinedOutput = readGeneratedFilesText(tempClientDir);
      const missing = errorCodeSchema.options.filter((code) => !combinedOutput.includes(`"${code}"`));

      expect(missing, `missing error code(s) from the generated client: ${JSON.stringify(missing)}`).toEqual([]);
    });
  });
});
