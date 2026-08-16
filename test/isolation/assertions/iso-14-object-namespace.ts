import { writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanFixturesForKeyLiterals, scanSrcForKeyLiterals } from "../support/key-construction-scanner.js";
import type { Breaker } from "../support/breakers.js";

// security-and-tenancy.md §10 ISO-14 / STORY-012 T21 · D-4 — no S3/IAM infra
// exists yet, so this is the same scanner approach as ISO-13, over the
// canonical `{env}/{workspace_id}/…` object-key shape (D-4's resolution).
const OBJECT_KEY_PATTERN = /`(\$\{[\w.]+\}\/[^`\n]*)`/;

function isNamespacedObjectKey(literal: string): boolean {
  const m = /^\$\{([\w.]+)\}\/\$\{([\w.]+)\}\//.exec(literal);
  if (!m) return false;
  const [, firstSegment, secondSegment] = m;
  // {env}/{workspace_id}/... in THAT order — a bare "two interpolated
  // segments separated by /" check can't tell {env}/{ws}/ from {ws}/{env}/
  // apart, which is exactly the prefix-mistake ISO-14 exists to catch.
  return /env/i.test(firstSegment!) && /workspace|^ws/i.test(secondSegment!);
}

export async function assertIso14ObjectNamespacing(): Promise<void> {
  const fixtureMatches = await scanFixturesForKeyLiterals(OBJECT_KEY_PATTERN);
  const goodCount = fixtureMatches.filter((m) => isNamespacedObjectKey(m.text)).length;
  const badCount = fixtureMatches.length - goodCount;
  if (fixtureMatches.length !== 2 || goodCount !== 1 || badCount !== 1) {
    throw new Error(
      `ISO-14 scanner self-test failed: found ${fixtureMatches.length} literal(s) (good=${goodCount} bad=${badCount}), ` +
        "expected 2 (1/1) — the scanner itself may be broken, so an empty src/ result cannot be trusted.",
    );
  }

  const srcMatches = await scanSrcForKeyLiterals(OBJECT_KEY_PATTERN);
  const bad = srcMatches.filter((m) => !isNamespacedObjectKey(m.text));
  if (bad.length > 0) {
    throw new Error(`ISO-14: un-namespaced object key construction site(s): ${bad.map((m) => `${m.file}:${m.line}`).join(", ")}`);
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROBE_FILE = path.join(__dirname, "..", "..", "..", "src", "lib", "_iso14_breaker_probe.ts");

export const iso14Breaker: Breaker = {
  id: "ISO-14",
  description: "plants an object key literal with the segments in the wrong order directly in src/",
  apply: async () => {
    await writeFile(
      PROBE_FILE,
      "export const probe = (workspaceId: string, env: string, id: string) => `${workspaceId}/${env}/reports/${id}.pdf`;\n",
    );
  },
  revert: async () => {
    await unlink(PROBE_FILE).catch(() => undefined);
  },
};
