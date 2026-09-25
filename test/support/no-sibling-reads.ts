import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// ⚠ STORY-155 — GAP G-12'S CLASS, CHECKED AT RUNTIME RATHER THAN BY PATTERN.
//
// G-12 was a test reading `../Nominara-Dev-Docs-main/`: present on this
// machine, absent from every clean checkout, so the test passed here and broke
// in CI. The first two guards against its return were STATIC — one matched the
// directory's name, the next matched three ways of writing a path that climbs
// out. A review walked five more forms past the second: a bare
// `readFileSync("../x")` (fs resolves it against the working directory), a
// lowercase `root`, a template join, `path.join(__dirname, "..", ...)`, and
// anything under `contracts/`, which the walk never covered. A longer list of
// patterns is never the fix.
//
// So this asks the only question that matters, of every path any test touches,
// however it was built: does it resolve to a SIBLING of this repository —
// somewhere under the repository's parent directory, but not inside the
// repository? On this machine those are the docs snapshot, the app, and a
// `nominara-api` symlink back to this repository; in CI there is nothing
// there. Every function Node's `fs` and `fs/promises` export is wrapped — the
// population is the module's own exports, not a list chosen here.
//
// Scope, stated rather than implied: this guards test PROCESSES (every vitest
// worker, through `setupFiles` in all three configs), and paths passed to fs.
// It does not see a child process's reads, a shell command, or a path above
// the repository's parent (such as $HOME, where testcontainers legitimately
// reads its own configuration).

const REPO = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const PARENT = dirname(REPO);

export class SiblingReadError extends Error {
  constructor(fn: string, path: string) {
    super(
      `${fn}(${path}) reaches a sibling of the repository. It exists on this machine and not in a clean ` +
        "checkout, so CI cannot see it (gap G-12). Mirror the file into docs/references/ and read it from there.",
    );
    this.name = "SiblingReadError";
  }
}

let allowed = 0;

/** Runs `fn` with sibling reads permitted. For the one spec that compares the mirror against its original. */
export function allowSiblingReads<T>(fn: () => T): T {
  allowed++;
  try {
    return fn();
  } finally {
    allowed--;
  }
}

function asPath(value: unknown): string | null {
  if (typeof value === "string") return resolve(value);
  if (value instanceof URL) return value.protocol === "file:" ? resolve(fileURLToPath(value)) : null;
  if (Buffer.isBuffer(value)) return resolve(value.toString());
  return null;
}

export function isSibling(path: string): boolean {
  const insideParent = path === PARENT || path.startsWith(PARENT + sep);
  const insideRepo = path === REPO || path.startsWith(REPO + sep);
  return insideParent && !insideRepo;
}

/** The fs functions whose SECOND argument is also a path. Every other function's first argument is its only one. */
const TWO_PATHS = new Set(["copyFile", "cp", "rename", "link", "symlink"]);

function guard(module: Record<string, unknown>, returnsPromises: boolean): number {
  let wrapped = 0;
  for (const name of Object.keys(module)) {
    const original = module[name];
    // Functions only; classes (ReadStream, Dirent, ...) start upper-case.
    if (typeof original !== "function" || /^[A-Z]/u.test(name)) continue;
    const base = name.replace(/Sync$/u, "");
    const checked = TWO_PATHS.has(base) ? 2 : 1;
    module[name] = function (this: unknown, ...args: unknown[]): unknown {
      if (allowed === 0) {
        for (let index = 0; index < checked; index++) {
          const path = asPath(args[index]);
          if (path !== null && isSibling(path)) {
            // Keep each API's own failure shape: a promise API rejects, a
            // synchronous or callback API throws at the call.
            const error = new SiblingReadError(name, path);
            if (returnsPromises) return Promise.reject(error);
            throw error;
          }
        }
      }
      return (original as (...a: unknown[]) => unknown).apply(this, args);
    };
    wrapped++;
  }
  return wrapped;
}

const installed = (globalThis as { __nominaraSiblingGuard?: number }).__nominaraSiblingGuard;
if (installed === undefined) {
  const count =
    guard(fs as unknown as Record<string, unknown>, false) + guard(fs.promises as unknown as Record<string, unknown>, true);
  // ESM named imports of node:fs and node:fs/promises are live bindings onto
  // these objects; this makes them see the wrapped functions too.
  syncBuiltinESMExports();
  (globalThis as { __nominaraSiblingGuard?: number }).__nominaraSiblingGuard = count;
}
