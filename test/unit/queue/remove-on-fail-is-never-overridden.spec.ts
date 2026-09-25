import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { QUEUE_TOPOLOGY } from "../../../src/lib/queue/topology.js";

// ⚠ STORY-154 — WHY A SECOND FILE JUST FOR ONE JOB OPTION.
//
// The dead-letter handler decides a failure is terminal from `job.finishedOn`,
// which BullMQ sets on its non-retry branch regardless of what happens to the
// job afterwards. That is deliberately NOT `job.isFailed()`, which reads the
// failed SET and therefore answers "not terminal" for a terminal job that
// `removeOnFail` has already deleted — measured against a real Valkey with
// `removeOnFail: true` and `{ count: 0 }`.
//
// So the DLQ write itself is safe under any `removeOnFail`. What is NOT safe is
// the rest of the system: a removed job leaves no `failed` entry for an
// operator to inspect, nothing for `admin-dlq-replay` to reconcile against, and
// no evidence that the DLQ entry corresponds to anything real. The topology
// pins `removeOnFail` to `{ age: GLOBAL_REMOVE_ON_FAIL.age }` with a
// `z.literal().strict()` so no ENTRY can change it — but `JobsOptions` is
// per-call, and `queue.add(name, data, { removeOnFail: true })` never goes near
// that schema.
//
// This is that gap, closed the only way that survives a new file being added:
// the default is REPORT. Every mention of `removeOnFail` in src/ must be one of
// the two forms known to be safe, and anything else fails NAMING ITSELF. An
// allow-list of the three current enqueue sites would have said nothing about
// the fourth.
describe("STORY-154 · removeOnFail is never overridden per job", () => {
  const SRC = fileURLToPath(new URL("../../../src", import.meta.url));

  const tsFiles = (() => {
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        // ⚠ EVERY TypeScript EXTENSION, NOT `.ts`. A review defeated both
        // checks below with a single `.mts` file carrying both forbidden
        // forms — on a spec whose stated premise is "the only way that
        // survives a new file being added".
        else if (/\.[cm]?tsx?$/u.test(name)) found.push(full);
      }
    };
    walk(SRC);
    return found;
  })();

  it("the file census is non-empty, reaches the queue module, and covers every TS extension", () => {
    // An empty walk would make every assertion below vacuous.
    expect(tsFiles.length).toBeGreaterThan(50);
    expect(tsFiles.some((f) => f.endsWith(join("lib", "queue", "queue-factory.ts")))).toBe(true);
    // The matcher itself, pinned — a walk that silently stopped seeing .mts
    // would report clean forever.
    for (const name of ["a.ts", "a.mts", "a.cts", "a.tsx"]) {
      expect(/\.[cm]?tsx?$/u.test(name), `${name} must be scanned`).toBe(true);
    }
    for (const name of ["a.js", "a.json", "a.ts.map", "a.d.ts.bak"]) {
      expect(/\.[cm]?tsx?$/u.test(name), `${name} must not be scanned`).toBe(false);
    }
  });

  it("⚠ every removeOnFail in src/ either DEFINES the topology value or passes it through unchanged", () => {
    const offenders: string[] = [];
    let passthroughs = 0;

    for (const file of tsFiles) {
      const rel = relative(SRC, file);
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        if (!line.includes("removeOnFail")) return;
        const trimmed = line.trim();
        // Prose is not a job option — but a comment mentioning it is also not
        // evidence of anything, so it is simply skipped rather than trusted.
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
        // Form 1: the topology module DEFINING the single permitted value —
        // narrowed to the three declared forms. A whole-file exemption let any
        // shape through in the one file whose job is to constrain the option.
        if (rel === join("lib", "queue", "topology.ts")) {
          if (/^removeOnFail:\s*z\./u.test(trimmed)) return;
          if (/^removeOnFail:\s*GLOBAL_REMOVE_ON_FAIL,?$/u.test(trimmed)) return;
          if (trimmed.includes("Omit<QueueTopologyEntry")) return;
          offenders.push(`${rel}:${String(index + 1)} — ${trimmed}`);
          return;
        }
        // Form 2: a verbatim pass-through of that value.
        if (/^removeOnFail:\s*entry\.removeOnFail,?$/u.test(trimmed)) {
          passthroughs++;
          return;
        }
        offenders.push(`${rel}:${String(index + 1)} — ${trimmed}`);
      });
    }

    expect(
      offenders,
      "a per-job removeOnFail bypasses topology.ts's z.literal() schema entirely. A removed failed job leaves " +
        "the DLQ entry with nothing to reconcile against. Pass entry.removeOnFail, or change the topology value.",
    ).toEqual([]);
    // Anti-vacuity: a regex that matched nothing would also produce zero
    // offenders. There are three enqueue sites today.
    expect(passthroughs, "no pass-through found — the check matched nothing and proved nothing").toBeGreaterThanOrEqual(3);
  });

  it("⚠ no queue or worker sets defaultJobOptions, which would apply under every enqueue site at once", () => {
    const offenders = tsFiles
      .flatMap((file) => {
        const rel = relative(SRC, file);
        return readFileSync(file, "utf8")
          .split("\n")
          .map((line, index) => ({ rel, line: line.trim(), n: index + 1 }))
          .filter(({ line }) => line.includes("defaultJobOptions") && !line.startsWith("//") && !line.startsWith("*"));
      })
      .map(({ rel, line, n }) => `${rel}:${String(n)} — ${line}`);

    // ⚠ ITS OWN ANTI-VACUITY CONTROL. The sibling check above counts
    // pass-throughs so a broken pattern fails; this one had nothing, so a
    // mistyped literal would have reported clean forever. A review named that
    // asymmetry, and the commit message had claimed both were covered.
    const matches = (line: string): boolean =>
      line.includes("defaultJobOptions") && !line.startsWith("//") && !line.startsWith("*");
    expect(matches("defaultJobOptions: { attempts: 3 },"), "the matcher does not recognise a real use").toBe(true);
    expect(matches("// defaultJobOptions is never set"), "the matcher reads a comment as code").toBe(false);

    expect(
      offenders,
      "defaultJobOptions would let a removeOnFail reach every job on a queue without touching any enqueue site.",
    ).toEqual([]);
  });

  it("the topology value itself is a retention window, not a removal", () => {
    // The pass-through above is only worth anything if what it passes through
    // actually retains the job.
    expect(QUEUE_TOPOLOGY.length).toBeGreaterThan(0);
    for (const entry of QUEUE_TOPOLOGY) {
      expect(entry.removeOnFail, `${entry.name} must retain failed jobs`).toEqual(
        expect.objectContaining({ age: expect.any(Number) }),
      );
      expect(entry.removeOnFail.age, `${entry.name} retention must be a real window`).toBeGreaterThan(0);
    }
  });
});
