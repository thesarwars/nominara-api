import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ⚠ STORY-155 — GAP G-12, SETTLED AS A VENDORED MIRROR.
//
// realtime-event-catalog.spec.ts checks the code against api-specification.md
// §11 itself. It used to read the file from `../Nominara-Dev-Docs-main/`,
// which no fresh clone has — so the first CI run failed on it, deliberately
// and loudly. The docs snapshot cannot be pushed anywhere CI could fetch it
// from, so the reference now lives in this repository as a byte-identical
// mirror under docs/references/, the arrangement docs/plans/dev-plan.md
// already uses.
//
// A mirror is only as good as its freshness, and this file is what keeps it
// honest. Two halves:
//   1. wherever the snapshot IS present — every machine that edits the docs —
//      every mirrored file must equal its original byte for byte;
//   2. nothing in src/ or test/ may read the snapshot at runtime. Without this
//      half, the next test to reach outside the repository reopens G-12 and
//      nobody finds out until CI is red.
describe("STORY-155 · docs/references is a faithful mirror of the docs snapshot", () => {
  const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
  const MIRROR = resolve(REPO_ROOT, "docs/references");
  /** Overridable so the comparison itself can be tested against a planted snapshot. */
  const SNAPSHOT = resolve(process.env.NOMINARA_DOCS_SNAPSHOT ?? resolve(REPO_ROOT, "../Nominara-Dev-Docs-main"), "references");
  const SNAPSHOT_PRESENT = existsSync(SNAPSHOT);

  const mirrored = readdirSync(MIRROR).filter((name) => statSync(join(MIRROR, name)).isFile());
  const sha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

  it("the mirror exists and carries the reference the catalog test reads", () => {
    // Runs everywhere, CI included. A deleted mirror must fail here, not
    // surface as a confusing read error somewhere else.
    expect(mirrored).toContain("api-specification.md");
  });

  // Visible as SKIPPED, never silently passing, where the snapshot is absent —
  // CI and any clone without the docs beside it. There is nothing to compare
  // against there; the committed mirror IS the reference.
  describe.skipIf(!SNAPSHOT_PRESENT)(`byte-identical to the snapshot at ${SNAPSHOT}`, () => {
    it.each(mirrored)("⚠ %s matches its original", (name) => {
      const original = join(SNAPSHOT, name);
      expect(existsSync(original), `${name} is mirrored but the snapshot has no such file — delete the mirror or restore the original`).toBe(true);
      expect(
        sha256(join(MIRROR, name)),
        `docs/references/${name} has drifted from the snapshot. Re-copy it: cp ${original} docs/references/${name}`,
      ).toBe(sha256(original));
    });
  });

  it("⚠ nothing in src/ or test/ reads the docs snapshot at runtime", () => {
    const THIS_FILE = relative(REPO_ROOT, fileURLToPath(import.meta.url));
    const offenders: string[] = [];
    let scanned = 0;
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
          if (name !== "node_modules") walk(full);
          continue;
        }
        if (!/\.[cm]?tsx?$/u.test(name)) continue;
        scanned++;
        const rel = relative(REPO_ROOT, full);
        if (rel === THIS_FILE) continue; // the one file that reads it on purpose, to compare
        readFileSync(full, "utf8")
          .split("\n")
          .forEach((line, index) => {
            const trimmed = line.trim();
            // Prose about the snapshot is fine — two comments in src/ cite it
            // as the origin of what they encode.
            if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
            if (trimmed.includes("Nominara-Dev-Docs-main")) offenders.push(`${rel}:${String(index + 1)} — ${trimmed}`);
          });
      }
    };
    walk(resolve(REPO_ROOT, "src"));
    walk(resolve(REPO_ROOT, "test"));

    expect(scanned, "the walk found nothing — this check would be vacuous").toBeGreaterThan(200);
    expect(
      offenders,
      "code outside this repository is not in a fresh clone, so CI cannot see it (gap G-12). Mirror the file " +
        "into docs/references/ and read it from there — the mirror check above keeps it faithful.",
    ).toEqual([]);
  });
});
