import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyFakeApiEnv } from "../support/fake-env.js";

// STORY-023 T2 (RED step) — Test scenarios 2 and 3:
//   2  Hand-edit the document              -> the drift check fails
//   3  Change a schema without regenerating -> the drift check fails
// AC3: "A drift check compares the schemas against the committed document
// and fails the build. There is no warning mode, and hand-editing the
// document is never correct."
//
// Coordinator's code-review round 2, B3: everything in this file's first
// version ran through a PURE comparator function receiving both documents
// as plain arguments — a `check.ts` whose CLI wrapper did
// `if (!isClean(r)) console.warn(...)` (log-and-continue, exit 0 always)
// would have satisfied every assertion. AC3's "there is no warning mode" is
// a claim about the CLI's EXIT CODE, which only a real subprocess
// invocation can prove. This file now `spawnSync`s the actual
// `tsx src/contracts/check.ts <documentPath>` command (same `tsx <path>.ts`
// invocation shape as every `db:*` script in package.json) twice: once
// against the real, untouched committed document (must exit 0) and once
// against a hand-edited COPY (must exit non-zero) — the pair together is
// what a stub CLI cannot satisfy either direction of (an "always exits 0"
// stub fails the second case; an "always exits 1" stub fails the first).
//
// Correction to this file's own first-version header comment: BOTH
// src/db/drift-check.ts's `checkDrift`/`isClean` AND
// src/db/rls/rls-check.ts's `checkRls`/`isClean` exist in this codebase
// (test/integration/rls-check.spec.ts is real and does test `checkRls`
// directly) — what does NOT exist anywhere in this codebase is a test of
// either one's CLI wrapper's `process.exit()` call. `check.ts`'s planned
// interface below therefore accepts a document-path override as a CLI
// positional argument (`process.argv[2]`), the same "explicit input, no
// implicit disk read baked into the pure logic" shape `checkDrift(client,
// migrationsDir)` and `checkRls(client)` both already use — defaulting to
// the real committed path only when the argument is omitted, which is what
// lets THIS file point it at a fixture copy without ever touching the real
// contracts/openapi.generated.json on disk.
//
// `src/contracts/check.ts` does not exist yet (task T3, deliberately not
// created here) — `spawnSync` against a missing script/tsx failing to
// resolve it is the expected RED reason today, not a hard-coded assumption
// about its exit code.
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const TSX_BIN = resolve(REPO_ROOT, "node_modules/.bin/tsx");
const CHECK_SCRIPT = resolve(REPO_ROOT, "src/contracts/check.ts");
const COMMITTED_DOCUMENT_PATH = resolve(REPO_ROOT, "contracts/openapi.generated.json");

function runCheck(documentPath: string): { status: number | null; output: string } {
  const result = spawnSync(TSX_BIN, [CHECK_SCRIPT, documentPath], { cwd: REPO_ROOT, encoding: "utf8" });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

describe("STORY-023 · contracts:check — the drift check's HARD FAILURE PATH over a real subprocess (AC3: no warning mode)", () => {
  const originalEnv = { ...process.env };
  let tempDir: string | undefined;

  beforeEach(() => {
    // spawnSync inherits process.env by default (no explicit `env` option
    // below) — check.ts boots the real ApiModule per ADR-0002 and needs
    // these the same way every other file in this suite does.
    applyFakeApiEnv();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it(
    "exits 0 against the untouched, committed document",
    () => {
      const result = runCheck(COMMITTED_DOCUMENT_PATH);
      expect(result.status, `expected exit code 0, got ${result.status}. Output:\n${result.output}`).toBe(0);
    },
    30_000,
  );

  it(
    "scenarios 2/3 — exits NON-ZERO against a hand-edited fixture copy of the document, with no intermediate warning-only exit code",
    () => {
      // "a fixture copy" — a NEW temp file, never the real committed file
      // on disk. Someone opens openapi.generated.json by hand and deletes
      // the worked example's requestBody — the same observable shape as
      // "hand-edit the document" (scenario 2) or "a schema changed and
      // nobody regenerated" (scenario 3): either way, what check.ts
      // recomputes from the LIVE schemas no longer matches this file.
      const document = JSON.parse(readFileSync(COMMITTED_DOCUMENT_PATH, "utf8"));
      delete document.paths["/v1/workspaces"].post.requestBody;

      // node_modules/.tmp-* — gitignored (node_modules/ is a whole-tree
      // .gitignore entry) and still inside api/'s own node_modules subtree
      // resolution ancestry, so a hard kill mid-test never dirties the
      // working tree.
      tempDir = mkdtempSync(resolve(REPO_ROOT, "node_modules/.tmp-story023-check-"));
      const mutatedPath = resolve(tempDir, "openapi.hand-edited.json");
      writeFileSync(mutatedPath, JSON.stringify(document, null, 2));

      const result = runCheck(mutatedPath);
      expect(result.status, `expected a non-zero exit code, got ${result.status}. Output:\n${result.output}`).not.toBe(
        0,
      );
    },
    30_000,
  );
});
