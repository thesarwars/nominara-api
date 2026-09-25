import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ⚠ STORY-155 — THE WORKFLOW'S GATE LIST, HELD AGAINST THE SCRIPTS IT RUNS.
//
// `.github/workflows/gates.yml` names each gate by hand, and a hand-written
// list is the shape this codebase has paid for over and over: complete for the
// world as it stood, silent about the next entry. A `test:golden` script added
// next month would exist, pass locally, and never run in CI — with nothing to
// say so.
//
// So the population is DERIVED from package.json: every script named like a
// gate must be run by the workflow or declared exempt WITH A REASON, and the
// exemptions are themselves checked for liveness. The default is to report.
describe("STORY-155 · the CI workflow runs every gate package.json declares", () => {
  const root = (relative: string): string => fileURLToPath(new URL(`../../../${relative}`, import.meta.url));
  const workflow = readFileSync(root(".github/workflows/gates.yml"), "utf8");
  const scripts = (JSON.parse(readFileSync(root("package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;

  /** A gate, by naming convention: lint, typecheck, `test:*`, or anything ending in `check`. */
  const GATE = /^(?:lint|typecheck|test:.+|.+[:-]check)$/u;

  /** Every `- run: pnpm <script>` step. Anchored to a step, so a YAML comment mentioning a script does not count. */
  const invoked = new Set([...workflow.matchAll(/^\s*-\s*run:\s*pnpm\s+([a-z][\w:.-]*)\s*$/gmu)].map((m) => m[1]!));

  /**
   * Gate-shaped scripts CI deliberately does not run. Each needs a reason a
   * reviewer can argue with; "not wired up yet" is not one — that is a gap,
   * and a gap should fail.
   */
  const EXEMPT: Readonly<Record<string, string>> = {
    "db:role-check":
      "asserts the connection is NOT the migration owner — a deploy-time check against the runtime role's URL. " +
      "CI connects as the superuser that owns the shadow databases, so it fails here by design.",
    "db:purge-check":
      "the release-train half of NFR-CMP-05, read against production's purge_failures table. " +
      "On CI's empty database it can only ever pass, which would make it decorative.",
  };

  it("the census found the gates, and the matchers recognise what they claim to", () => {
    // Anti-vacuity, both directions. A regex that matched nothing would make
    // every assertion below pass on an empty set.
    expect(invoked.size, "no `run: pnpm <script>` steps found — the matcher is broken").toBeGreaterThanOrEqual(10);
    expect(invoked.has("test:integration")).toBe(true);
    for (const name of ["lint", "typecheck", "test:unit", "test:isolation:breakers", "contracts:check", "db:rls-check"]) {
      expect(GATE.test(name), `${name} should count as a gate`).toBe(true);
    }
    for (const name of ["build", "db:migrate", "audit:verify", "test", "client:generate"]) {
      expect(GATE.test(name), `${name} should not count as a gate`).toBe(false);
    }
    // A commented-out step is not a step.
    expect(/^\s*-\s*run:\s*pnpm\s+([a-z][\w:.-]*)\s*$/mu.test("      # - run: pnpm test:golden")).toBe(false);
  });

  it("⚠ every gate-shaped script is run by the workflow or exempt with a reason", () => {
    const unrun = Object.keys(scripts).filter((name) => GATE.test(name) && !invoked.has(name) && !(name in EXEMPT));
    expect(
      unrun,
      "a gate script exists that CI never runs. Add a `- run: pnpm <name>` step to .github/workflows/gates.yml, " +
        "or add it to EXEMPT here with a reason a reviewer can argue with.",
    ).toEqual([]);
  });

  it("every step names a script that exists", () => {
    // A renamed script would otherwise surface only as a red run on GitHub.
    expect([...invoked].filter((name) => !(name in scripts))).toEqual([]);
  });

  it("every exemption is still a script, and still not run — so none outlives its reason", () => {
    for (const name of Object.keys(EXEMPT)) {
      expect(name in scripts, `EXEMPT names ${name}, which package.json no longer has`).toBe(true);
      expect(invoked.has(name), `${name} is both exempt and run — delete the exemption`).toBe(false);
    }
  });

  it("⚠ every action is GitHub-owned and pinned to a full commit SHA", () => {
    // A tag like `@v7` can be re-pointed by whoever controls the action's
    // repository; a 40-hex SHA cannot. And a third-party action is a
    // dependency (development-workflow.md §6), so adding one should be a
    // visible decision that fails here first rather than a line in a diff.
    const uses = [...workflow.matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)/gmu)].map((m) => m[1]!);
    expect(uses.length, "no `uses:` lines found — the matcher is broken").toBeGreaterThanOrEqual(2);
    for (const ref of uses) {
      expect(ref, `${ref} is not pinned to a full commit SHA`).toMatch(/@[0-9a-f]{40}$/u);
      expect(ref, `${ref} is not a GitHub-owned action`).toMatch(/^actions\//u);
    }
  });

  it("the toolchain has one source: .nvmrc for Node, packageManager (with integrity) for pnpm", () => {
    expect(existsSync(root(".nvmrc"))).toBe(true);
    expect(workflow).toContain("node-version-file: .nvmrc");
    const pkg = JSON.parse(readFileSync(root("package.json"), "utf8")) as { packageManager?: string };
    expect(pkg.packageManager, "pnpm must be pinned with its integrity hash").toMatch(/^pnpm@\d+\.\d+\.\d+\+sha512\.[0-9a-f]{128}$/u);
    expect(workflow).toContain("corepack enable");
  });
});
