import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateClient, generateOpenApiDocument, type OpenApiDocument } from "../../src/contracts/generate.js";
import { applyFakeApiEnv } from "../support/fake-env.js";

// STORY-023 T2 (RED step) — Test scenario 9 ("Type-check a consumer against
// the previous minor -> passes") and AC10 ("The previous minor of the
// client is supported... This is what lets the repositories deploy
// independently" / NFR-REPO-03).
//
// *** PARTIAL PROOF — READ BEFORE TRUSTING THIS FILE ALONE (OQ-8) ***
// NFR-REPO-03 ("the API supports the current and previous minor of the
// client (N-1)") is proven for real by a PUBLISHED N-1 release checked in
// CI (project-structure.md §7's "Contract test matrix" mechanism). This
// repository has no publish pipeline and no CI wired up yet, so there is no
// genuine previous-minor release to test against. Per the coordinator's
// OQ-8 resolution, this file proves ONLY the provable half — SHAPE
// compatibility — against a committed PROXY document
// (contracts/baseline/openapi.previous-minor.json, a hand-authored stand-in
// for "the previous minor", not a real release artifact). The
// PUBLISHED-MATRIX half of NFR-REPO-03 remains UNPROVEN by this file and
// needs real CI to ever be provable — do not read a green run of this file
// as full NFR-REPO-03 coverage.
//
// Mechanism: generate a client from the previous-minor PROXY into one temp
// directory and from the CURRENT live document into another, write the
// SAME fixture consumer source into both, and `tsc --noEmit` each
// directory for real, using the already-installed `typescript` compiler
// (no new dependency added by this file). Both must pass: the consumer,
// written once against the narrower N-1 shape, must compile against BOTH
// the client generated from N-1 itself AND the client regenerated from the
// current, additively-wider schema — proving old code keeps compiling once
// the schema has only grown (additively), which is what makes an
// independent deploy safe.
//
// Coordinator's code-review round 2, M5: the fixture consumer below reads
// `data?.slug` off the RESPONSE, not just sending a request — a version
// that only ever builds a request body proves the REQUEST side alone; you
// could delete every response property and it would still type-check.
// `slug` is declared by BOTH the N-1 proxy and the current schema, so
// reading it is valid against either client — but if a later regression
// removed or narrowed `slug` on the CURRENT schema, the type-check against
// `currentDir` below would turn red, which a request-only consumer could
// never catch.
//
// STORY-023 T3 (GREEN step) — `generateOpenApiDocument`/`generateClient` are
// imported directly as literal static imports now that `src/contracts/
// generate.ts` exists (the RED step's non-literal loader and local
// `GeneratedDocument` interface, a hand-written duplicate of generate.ts's
// own exported `OpenApiDocument` type, are both gone). `generateClient()`
// itself is still task T4's job — it throws until then, which is the
// correct, expected failure for this file's one test.
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const TSC_BIN = resolve(REPO_ROOT, "node_modules/.bin/tsc");

// The fixture consumer — hand-written ONCE, run against BOTH client
// generations. Request side only ever uses fields the PREVIOUS minor's
// proxy document accepts (`name` alone — never `org_type`/`region`/
// `timezone`, which the current schema also accepts but the proxy's
// requestBody does not, and never `entitlement_version`, a
// current-schema-only RESPONSE field), because a consumer coded against
// N-1 cannot know about a field N-1 does not have. Response side reads
// `slug` — present in both documents (M5) — THROUGH the envelope's `data`
// member (STORY-024 T11), which both documents now carry.
const FIXTURE_CONSUMER_SOURCE = `
import type { paths } from "./types.js";
import createClient from "openapi-fetch";

const client = createClient<paths>({ baseUrl: "https://api.nominara.com" });

export async function createWorkspaceAgainstPreviousMinorShape() {
  const { data, error } = await client.POST("/v1/workspaces", {
    body: { name: "Acme Co" },
  });
  const slug: string | undefined = data?.data.slug;
  return { slug, error };
}
`;

/** Files only — readFileSync-ing a directory entry throws EISDIR. */
function findGeneratedTypesFile(dir: string): string {
  const candidate = readdirSync(dir)
    .filter((name) => statSync(resolve(dir, name)).isFile())
    .find((name) => {
      const content = readFileSync(resolve(dir, name), "utf8");
      return content.includes("export interface paths") || content.includes("export type paths");
    });
  if (!candidate) {
    throw new Error(
      `generateClient() did not write any file under ${dir} exporting a "paths" type — cannot locate it for the fixture consumer's "./types.js" import.`,
    );
  }
  return candidate;
}

/** Runs the real `tsc --noEmit` (already-installed devDependency, no new dependency) against `dir`. */
function typeCheckDirectory(dir: string): { success: boolean; output: string } {
  const result = spawnSync(TSC_BIN, ["--noEmit", "-p", resolve(dir, "tsconfig.json")], {
    cwd: dir,
    encoding: "utf8",
  });
  return {
    success: result.status === 0,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

function writeFixtureConsumerProject(dir: string, typesFileName: string): void {
  writeFileSync(
    resolve(dir, "consumer.ts"),
    FIXTURE_CONSUMER_SOURCE.replace("./types.js", `./${typesFileName.replace(/\.(ts|d\.ts)$/, "")}.js`),
  );
  writeFileSync(
    resolve(dir, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2023",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          skipLibCheck: true,
          noEmit: true,
        },
        include: ["./*.ts"],
      },
      null,
      2,
    ),
  );
}

describe("STORY-023 · scenario 9 — a client generated from the previous minor supports a fixture consumer (partial proof — see file header)", () => {
  const originalEnv = { ...process.env };
  let previousMinorDir: string | undefined;
  let currentDir: string | undefined;

  beforeEach(() => {
    applyFakeApiEnv();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    // Temp directories are created under node_modules/ (gitignored as a
    // whole tree) rather than the repo root directly or os.tmpdir() — a
    // hard kill mid-test never dirties `git status`, and Node/TS's upward
    // node_modules resolution walk from inside them still reaches
    // api/node_modules and can find `openapi-fetch` once task T3 adds it.
    // Always removed here regardless of outcome.
    for (const dir of [previousMinorDir, currentDir]) {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
    previousMinorDir = undefined;
    currentDir = undefined;
  });

  it(
    "a consumer written against the previous-minor proxy type-checks against BOTH the previous-minor client and the current client",
    async () => {
      const previousMinorDocumentPath = resolve(REPO_ROOT, "contracts/baseline/openapi.previous-minor.json");
      const previousMinorDocument = JSON.parse(readFileSync(previousMinorDocumentPath, "utf8")) as OpenApiDocument;
      const currentDocument = await generateOpenApiDocument();

      previousMinorDir = mkdtempSync(resolve(REPO_ROOT, "node_modules/.tmp-story023-client-previous-minor-"));
      currentDir = mkdtempSync(resolve(REPO_ROOT, "node_modules/.tmp-story023-client-current-"));

      await generateClient(previousMinorDocument, previousMinorDir);
      await generateClient(currentDocument, currentDir);

      const previousTypesFile = findGeneratedTypesFile(previousMinorDir);
      const currentTypesFile = findGeneratedTypesFile(currentDir);

      writeFixtureConsumerProject(previousMinorDir, previousTypesFile);
      writeFixtureConsumerProject(currentDir, currentTypesFile);

      const previousResult = typeCheckDirectory(previousMinorDir);
      expect(
        previousResult.success,
        `type-check against the previous-minor client failed:\n${previousResult.output}`,
      ).toBe(true);

      const currentResult = typeCheckDirectory(currentDir);
      expect(
        currentResult.success,
        `the SAME consumer failed to type-check against the CURRENT client (forward-compatibility broken):\n${currentResult.output}`,
      ).toBe(true);
    },
    60_000,
  );
});
