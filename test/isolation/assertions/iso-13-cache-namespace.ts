import { writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanFixturesForKeyLiterals, scanSrcForKeyLiterals } from "../support/key-construction-scanner.js";
import type { Breaker } from "../support/breakers.js";

// security-and-tenancy.md §10 ISO-13 / STORY-012 T20 · D-3 — no Valkey
// integration exists yet (D-3, joins in STORY-030), so this is a fail-closed
// SCANNER over cache-key-construction sites in src/. Legitimately finds ZERO
// call sites today — the scanner self-tests against a small fixture
// directory first (three known literals, correctly classified) so that
// "zero in src/" is a trustworthy result, not indistinguishable from a
// broken/no-op scanner (T20's own anti-vacuity requirement).
// Requires the literal to OPEN with an interpolation (`${...}`) immediately —
// this is what excludes ordinary doc-comment code spans and error-message
// template literals elsewhere in this codebase (e.g. `` `v1:{dek_id}:...` ``,
// `` `db:rls-generate --check failed: ...` ``), which contain colons but
// never open with an interpolation.
const CACHE_KEY_PATTERN = /`(\$\{[^`\n]*:[^`\n]*:[^`\n]*)`/;

type Classification = "valid" | "exception" | "invalid";

function classifyCacheKey(literal: string): Classification {
  const m = /^\$\{([\w.]+)\}:(.*)$/.exec(literal);
  if (!m) return "invalid";
  const [, firstSegment, rest] = m;
  if (!/env/i.test(firstSegment!)) return "invalid";
  // The one documented exception: the shared, global answer cache.
  if (/^global:capture:/.test(rest!)) return "exception";
  // {env}:{workspace_id}:... — the second segment must ALSO be an
  // interpolation naming something workspace-like, not just any identifier.
  const second = /^\$\{([\w.]+)\}:/.exec(rest!);
  if (second && /workspace|^ws/i.test(second[1]!)) return "valid";
  return "invalid";
}

export async function assertIso13CacheNamespacing(): Promise<void> {
  const fixtureMatches = await scanFixturesForKeyLiterals(CACHE_KEY_PATTERN);
  const counts = { valid: 0, exception: 0, invalid: 0 } as Record<Classification, number>;
  for (const m of fixtureMatches) counts[classifyCacheKey(m.text)]++;
  if (fixtureMatches.length !== 3 || counts.valid !== 1 || counts.exception !== 1 || counts.invalid !== 1) {
    throw new Error(
      `ISO-13 scanner self-test failed: found ${fixtureMatches.length} literal(s) ` +
        `(valid=${counts.valid} exception=${counts.exception} invalid=${counts.invalid}), expected 3 (1/1/1) — ` +
        "the scanner itself may be broken, so an empty src/ result cannot be trusted.",
    );
  }

  const srcMatches = await scanSrcForKeyLiterals(CACHE_KEY_PATTERN);
  const invalid = srcMatches.filter((m) => classifyCacheKey(m.text) !== "valid" && classifyCacheKey(m.text) !== "exception");
  if (invalid.length > 0) {
    throw new Error(`ISO-13: un-namespaced cache key construction site(s): ${invalid.map((m) => `${m.file}:${m.line}`).join(", ")}`);
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROBE_FILE = path.join(__dirname, "..", "..", "..", "src", "lib", "_iso13_breaker_probe.ts");

export const iso13Breaker: Breaker = {
  id: "ISO-13",
  description: "plants an un-namespaced cache key literal directly in src/ (no database policy exists for this scanner-based property)",
  apply: async () => {
    await writeFile(PROBE_FILE, "export const probe = (workspaceId: string, promptId: string) => `${workspaceId}:answers:${promptId}`;\n");
  },
  revert: async () => {
    await unlink(PROBE_FILE).catch(() => undefined);
  },
};
