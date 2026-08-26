import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// STORY-027 · scenario 8 — "Grep the test suites for a real adapter -> Zero
// matches." No real adapter exists yet (STORY-028/029 land ApiAdapter and
// LicensedSerpAdapter). This scanner is tested BOTH ways — against the real
// test/** tree (must be clean) and against a synthetic violating fixture
// (must be caught) — so it isn't a no-op that stays green forever,
// including after a later story lands a real adapter it should catch.
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const TEST_ROOT = resolve(REPO_ROOT, "test");

const BANNED_MODULE_PATH_PATTERN = /api-adapter|licensed-serp-adapter|headless-adapter/;
const BANNED_CLASS_NAME_PATTERN = /\bApiAdapter\b|\bLicensedSerpAdapter\b|\bHeadlessAdapter\b/;
// Known live-engine API hostnames — none of these belong in a test suite;
// FixtureAdapter never talks to a network at all.
const LIVE_ENGINE_HOSTNAME_PATTERN = /api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com|api\.perplexity\.ai/;

// This scanner's own defining patterns/examples necessarily contain the
// banned strings — excluded from its own sweep by filename, not by pattern
// (a pattern-based exclusion could hide a real violation too).
const SELF_PATH = fileURLToPath(import.meta.url);

export function findRealAdapterReferences(rootDir: string): string[] {
  const violations: string[] = [];
  for (const file of listFilesRecursively(rootDir)) {
    if (file === SELF_PATH) {
      continue;
    }
    const content = readFileSync(file, "utf8");
    if (
      BANNED_MODULE_PATH_PATTERN.test(content) ||
      BANNED_CLASS_NAME_PATTERN.test(content) ||
      LIVE_ENGINE_HOSTNAME_PATTERN.test(content)
    ) {
      violations.push(file);
    }
  }
  return violations;
}

function listFilesRecursively(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const info = statSync(fullPath);
    if (info.isDirectory()) {
      files.push(...listFilesRecursively(fullPath));
    } else if (extname(entry) === ".ts") {
      files.push(fullPath);
    }
  }
  return files;
}

describe("STORY-027 · scenario 8 · zero test files reference a real adapter", () => {
  it("no file under test/** references a real-adapter module path, class name, or live-engine hostname", () => {
    const violations = findRealAdapterReferences(TEST_ROOT);
    expect(violations).toEqual([]);
  });

  describe("the scanner is tested both ways — proven to catch a real violation, not just to stay quiet", () => {
    let fixtureDir: string | undefined;

    afterEach(() => {
      if (fixtureDir) {
        rmSync(fixtureDir, { recursive: true, force: true });
        fixtureDir = undefined;
      }
    });

    it("flags a synthetic file importing a real-adapter module path", () => {
      fixtureDir = mkdtempSync(resolve(REPO_ROOT, "node_modules/.tmp-story027-adapter-scan-"));
      const violatingFile = resolve(fixtureDir, "violating.spec.ts");
      writeFileSync(violatingFile, `import { ApiAdapter } from "../../src/lib/engines/api-adapter.js";\n`);

      const violations = findRealAdapterReferences(fixtureDir);
      expect(violations).toEqual([violatingFile]);
    });

    it("flags a synthetic file referencing a live-engine hostname", () => {
      fixtureDir = mkdtempSync(resolve(REPO_ROOT, "node_modules/.tmp-story027-adapter-scan-"));
      const violatingFile = resolve(fixtureDir, "violating.spec.ts");
      writeFileSync(violatingFile, `const url = "https://api.openai.com/v1/responses";\n`);

      const violations = findRealAdapterReferences(fixtureDir);
      expect(violations).toEqual([violatingFile]);
    });

    it("does NOT flag a clean synthetic file — the scanner isn't trivially over-broad", () => {
      fixtureDir = mkdtempSync(resolve(REPO_ROOT, "node_modules/.tmp-story027-adapter-scan-"));
      writeFileSync(
        resolve(fixtureDir, "clean.spec.ts"),
        `import { resolveEngine } from "../../src/lib/engines/registry.js";\n`,
      );

      const violations = findRealAdapterReferences(fixtureDir);
      expect(violations).toEqual([]);
    });
  });
});
