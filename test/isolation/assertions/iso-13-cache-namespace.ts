import { readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanFixturesForKeyLiterals, scanSrcForKeyLiterals } from "../support/key-construction-scanner.js";
import type { Breaker } from "../support/breakers.js";

// security-and-tenancy.md §10 ISO-13 / STORY-012 T20.
//
// *** THE PRECONDITION THIS WAS WRITTEN UNDER IS NO LONGER TRUE. ***
// It said "no Valkey integration exists yet (D-3, joins in STORY-030) …
// legitimately finds ZERO call sites today". STORY-025 falsified that: the
// cache instance, the key module and every idempotency and rate-limit key
// arrived, and this assertion was not updated with them. Worse, it COULD NOT
// see them — CACHE_KEY_PATTERN matches only template literals opening with an
// interpolation, and src/lib/cache/valkey-keys.ts builds every key with
// Array.join(":"). Deleting the workspace segment from tenantKey() left the
// always-blocking isolation gate green. Found by the dangerous-area audit of
// STORY-025, and it is exactly ISO-00's subject: an assertion that cannot fail
// is worse than no assertion, because it is trusted.
//
// So there are now TWO halves. The scanner below still guards literal
// construction anywhere in src/. The behavioural half calls the REAL exported
// constructors and asserts the workspace segment is present and is the value
// supplied — which is the half a breaker can move.
//
// The scanner half legitimately finds ZERO literal call sites today — the scanner self-tests against a small fixture
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

/**
 * The behavioural half: the real constructors, not a regex over their source.
 *
 * Every exported tenant-scoped key form must place the supplied workspace id in
 * segment 2, and two different workspaces must never produce the same key. That
 * is the property the whole STORY-025 tenant-boundary argument rests on, and
 * until now nothing in the isolation suite exercised it.
 */
async function assertTenantKeyConstructors(): Promise<void> {
  // A CACHE-BUSTED IMPORT, and it is what makes the breaker meaningful. ESM
  // caches a module by URL, so a breaker that edits the file on disk changes
  // nothing for an already-imported module — the assertion would keep passing
  // against a boundary that had just been deleted, which is the precise
  // failure this whole assertion was rewritten to stop. The query string
  // forces a fresh evaluation. The module has no side effects, so reloading it
  // costs nothing.
  const keys = (await import(
    `${new URL("../../../src/lib/cache/valkey-keys.js", import.meta.url).href}?iso13=${String(process.hrtime.bigint())}`
  )) as typeof import("../../../src/lib/cache/valkey-keys.js");
  const WS_A = "0192f1a0-0000-7000-8000-00000000000a";
  const WS_B = "0192f1a0-0000-7000-8000-00000000000b";

  const forms: { name: string; build: (workspaceId: string) => string }[] = [
    { name: "tenantKey", build: (ws) => keys.tenantKey("test", ws, "probe") },
    { name: "idempotencyRecordKey", build: (ws) => keys.idempotencyRecordKey("test", ws, "f".repeat(64)) },
    {
      name: "rateLimitCounterKey",
      build: (ws) => keys.rateLimitCounterKey("test", ws, "writes", "workspace", "r60000", ws),
    },
  ];

  for (const form of forms) {
    const a = form.build(WS_A);
    const b = form.build(WS_B);

    if (a === b) {
      throw new Error(`ISO-13 (constructors): ${form.name}() produces the SAME key for two workspaces — the tenant boundary is gone`);
    }
    const segments = a.split(":");
    if (segments[1] !== WS_A) {
      throw new Error(
        `ISO-13 (constructors): ${form.name}() does not place the workspace id in segment 2 (got "${segments[1] ?? ""}" in "${a}")`,
      );
    }
    if (!a.startsWith("test:")) {
      throw new Error(`ISO-13 (constructors): ${form.name}() does not carry the environment namespace (got "${a}")`);
    }
  }
}

export async function assertIso13CacheNamespacing(): Promise<void> {
  await assertTenantKeyConstructors();

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

// The breaker that used to live here planted an un-namespaced literal in src/
// and therefore demonstrated the SCANNER failing. It is gone, and the reason is
// worth stating: the scanner's own fixture self-test above already proves it is
// not vacuous (three literals, classified 1/1/1, checked on every run), while
// NOTHING proved the real constructors were guarded — and they were not. The
// registry allows one breaker per assertion, so it goes to the half that was
// actually unprotected.

const KEYS_FILE = path.join(__dirname, "..", "..", "..", "src", "lib", "cache", "valkey-keys.ts");
const KEYS_BACKUP = `${KEYS_FILE}.iso13-backup`;

/**
 * The breaker that matters: it removes the workspace segment from the REAL
 * constructor.
 *
 * `iso13Breaker` above plants a literal in `src/` and therefore exercises the
 * SCANNER. That is worth keeping, but it says nothing about the code this
 * repository actually ships — which is precisely how the assertion came to be
 * green against a tenant boundary it could not see. This one deletes the
 * boundary itself.
 */
export const iso13ConstructorBreaker: Breaker = {
  id: "ISO-13",
  description: "removes the workspace segment from tenantKey(), the real cache-key constructor",
  apply: async () => {
    const source = await readFile(KEYS_FILE, "utf8");
    await writeFile(KEYS_BACKUP, source);
    const broken = source.replace(
      '    assertSegment("workspace_id", workspaceId),\n',
      "",
    );
    if (broken === source) {
      throw new Error("ISO-13 breaker could not find the workspace segment to remove — has tenantKey() changed shape?");
    }
    await writeFile(KEYS_FILE, broken);
  },
  revert: async () => {
    const backup = await readFile(KEYS_BACKUP, "utf8").catch(() => undefined);
    if (backup !== undefined) {
      await writeFile(KEYS_FILE, backup);
      await unlink(KEYS_BACKUP).catch(() => undefined);
    }
  },
};

