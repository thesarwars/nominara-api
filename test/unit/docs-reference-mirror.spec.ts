import { createHash } from "node:crypto";
import { existsSync, promises as fsPromises, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { SiblingReadError, allowSiblingReads, isSibling } from "../support/no-sibling-reads.js";

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
// Two halves keep that honest:
//   1. wherever the snapshot IS present — every machine that edits the docs —
//      every mirrored file must equal its original byte for byte;
//   2. no test may read a SIBLING of the repository at all. That half is
//      enforced at RUNTIME by test/support/no-sibling-reads.ts in every vitest
//      worker; this file proves the guard is installed everywhere and fires.
//      The two static versions before it were pattern lists, and a review
//      walked five more ways of writing a path straight past the second.
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PARENT = dirname(resolve(REPO_ROOT));
const MIRROR = resolve(REPO_ROOT, "docs/references");
/** Overridable so the comparison itself can be tested against a planted snapshot. */
const SNAPSHOT = resolve(process.env.NOMINARA_DOCS_SNAPSHOT ?? join(PARENT, "Nominara-Dev-Docs-main"), "references");
// The one deliberate sibling read in the suite.
const SNAPSHOT_PRESENT = allowSiblingReads(() => existsSync(SNAPSHOT));

const mirrored = readdirSync(MIRROR).filter((name) => statSync(join(MIRROR, name)).isFile());
const sha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

describe("STORY-155 · docs/references is a faithful mirror of the docs snapshot", () => {
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
      allowSiblingReads(() => {
        expect(existsSync(original), `${name} is mirrored but the snapshot has no such file — delete the mirror or restore the original`).toBe(true);
        expect(
          sha256(join(MIRROR, name)),
          `docs/references/${name} has drifted from the snapshot. Re-copy it: cp ${original} docs/references/${name}`,
        ).toBe(sha256(original));
      });
    });
  });
});

describe("STORY-155 · no test can read a sibling of the repository", () => {
  it("⚠ the guard is wired into every vitest config — unit, integration and isolation", async () => {
    // Asked of the configs themselves, imported, not grepped.
    for (const file of ["vitest.config.ts", "vitest.integration.config.ts", "vitest.isolation.config.ts"]) {
      const config = ((await import(pathToFileURL(resolve(REPO_ROOT, file)).href)) as { default: { test?: { setupFiles?: string[] } } }).default;
      expect(config.test?.setupFiles, file).toContain("test/support/no-sibling-reads.ts");
    }
    // And it is installed in THIS worker, over the module's own export list.
    expect((globalThis as { __nominaraSiblingGuard?: number }).__nominaraSiblingGuard).toBeGreaterThan(100);
  });

  it("⚠ it refuses every way of writing a sibling path the reviews found — and the file need not exist", async () => {
    // The first guard matched a name; the second matched three spellings. Each
    // of these got past one of them. None is a pattern here: they all RESOLVE
    // under the repository's parent and outside the repository.
    expect(resolve(process.cwd()), "the cwd-relative case assumes vitest runs from the repository root").toBe(resolve(REPO_ROOT));
    const REPO_ROOT_lower = REPO_ROOT;
    const attempts: Array<[string, () => unknown]> = [
      ["the original G-12 form", () => readFileSync(resolve(REPO_ROOT, "../Nominara-Dev-Docs-main/references/api-specification.md"))],
      ["a different sibling", () => readFileSync(resolve(REPO_ROOT, "../client/package.json"))],
      ["separate `..` arguments", () => existsSync(join(REPO_ROOT, "..", "client"))],
      ["a bare cwd-relative path", () => readFileSync("../client/package.json")],
      ["a template join", () => existsSync(`${REPO_ROOT}/../client/package.json`)],
      ["a lower-case root variable", () => statSync(resolve(REPO_ROOT_lower, "..", "Nominara-Dev-Docs-main"))],
      ["a URL climbing from this file", () => readFileSync(new URL("../../../client/package.json", import.meta.url))],
      ["the parent directory itself", () => readdirSync(PARENT)],
      ["the symlink back to this repository", () => existsSync(join(PARENT, "nominara-api", "package.json"))],
      ["a name assembled from parts", () => existsSync(join(PARENT, ["Nominara", "Dev", "Docs", "main"].join("-")))],
    ];
    for (const [label, attempt] of attempts) expect(attempt, label).toThrow(SiblingReadError);
    await expect(fsPromises.readFile(join(PARENT, "client", "package.json")), "fs/promises").rejects.toThrow(SiblingReadError);
  });

  it("does NOT refuse the repository, the temp directory, or paths above the repository's parent", () => {
    // Anti-overreach: testcontainers reads its own config under $HOME, and
    // plenty of tests write to the temp directory.
    expect(isSibling(resolve(REPO_ROOT, "package.json"))).toBe(false);
    expect(isSibling(resolve(REPO_ROOT))).toBe(false);
    expect(isSibling(tmpdir())).toBe(false);
    expect(isSibling(homedir())).toBe(false);
    expect(() => readFileSync(resolve(REPO_ROOT, "package.json"))).not.toThrow();
    expect(() => existsSync(join(tmpdir(), "nominara-no-such-file"))).not.toThrow();
  });

  it("the one exemption re-arms as soon as it returns", () => {
    const sibling = join(PARENT, "Nominara-Dev-Docs-main");
    expect(() => allowSiblingReads(() => existsSync(sibling))).not.toThrow();
    expect(() => existsSync(sibling)).toThrow(SiblingReadError);
    // Even when the allowed block throws.
    expect(() =>
      allowSiblingReads(() => {
        throw new Error("inside");
      }),
    ).toThrow("inside");
    expect(() => existsSync(sibling)).toThrow(SiblingReadError);
  });
});
