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

/**
 * The REALTIME channels, which this assertion could not see at all.
 *
 * STORY-026's review found the socket.io adapter and emitter using the
 * library default channel prefix — the literal "socket.io", built INSIDE the
 * libraries, so it never passed through valkey-keys.ts and carried no
 * deployment segment. Two environments pointed at one Valkey cache instance
 * cross-broadcast every event of every workspace, in both directions; room
 * names are identical across deployments, so nothing downstream would notice.
 * That is ISO-13's own subject — a channel is a key — and this gate, the one
 * that exists to catch exactly this, was blind to it. The fix shipped guarded
 * only by a unit test.
 *
 * These channels are GLOBAL rather than tenant-scoped, so the property is not
 * "carries a workspace id" but "carries the deployment namespace, and two
 * deployments never collide".
 */
async function assertRealtimeChannelNamespacing(): Promise<void> {
  // Cache-busted for the same reason the constructor half is — see there.
  const stamp = String(process.hrtime.bigint());
  const namespaceModule = (await import(
    `${new URL("../../../src/lib/cache/key-namespace.js", import.meta.url).href}?iso13=${stamp}`
  )) as typeof import("../../../src/lib/cache/key-namespace.js");
  const publisher = (await import(
    `${new URL("../../../src/lib/cache/realtime-publisher.js", import.meta.url).href}?iso13=${stamp}`
  )) as typeof import("../../../src/lib/cache/realtime-publisher.js");

  const DEPLOY_A = "staging";
  const DEPLOY_B = "production";

  const forms: { name: string; build: (namespace: string) => string }[] = [
    { name: "socketIoChannelPrefix", build: (ns) => namespaceModule.socketIoChannelPrefix(ns) },
    { name: "realtimeControlChannel", build: (ns) => publisher.realtimeControlChannel(ns) },
    { name: "realtimeFanoutChannel", build: (ns) => publisher.realtimeFanoutChannel(ns) },
  ];

  const seen = new Map<string, string>();
  for (const form of forms) {
    const a = form.build(DEPLOY_A);
    const b = form.build(DEPLOY_B);

    if (a === b) {
      throw new Error(
        `ISO-13 (realtime): ${form.name}() produces the SAME channel for two deployments — ` +
          "staging and production sharing one Valkey would deliver each other's events",
      );
    }
    if (!a.startsWith(`${DEPLOY_A}:`)) {
      throw new Error(
        `ISO-13 (realtime): ${form.name}() does not open with the deployment namespace (got "${a}")`,
      );
    }
    // ...and the three must not collide with each other WITHIN a deployment:
    // a control message parsed as a client event, or either as an adapter
    // frame, would be a silent cross-wire.
    const previous = seen.get(a);
    if (previous !== undefined) {
      throw new Error(`ISO-13 (realtime): ${form.name}() collides with ${previous}() — both build "${a}"`);
    }
    seen.set(a, form.name);
  }
}

/**
 * THE ONE KEY THAT IS DELIBERATELY EXEMPT, asserted rather than assumed.
 *
 * §10 names the shared answer cache as the single documented exception to
 * tenant scoping. Until STORY-032's review, this assertion could see neither
 * half of it: `captureL1Key` was absent from the constructor list above, and
 * the literal it builds opened with `global:` rather than with an
 * interpolation, so `CACHE_KEY_PATTERN` never matched it either. The one key
 * in this repository that is allowed to be tenant-free was covered by
 * nothing — and it had drifted, shipping without the `{env}` segment three
 * references require.
 *
 * An exception that nothing checks is not an exception; it is a hole with a
 * comment next to it. So both halves of the exemption are pinned here: it
 * MUST carry the deployment namespace, and it MUST NOT vary by tenant.
 */
async function assertSharedAnswerCacheExemption(): Promise<void> {
  const keys = (await import(
    `${new URL("../../../src/lib/capture/l1-cache-key.js", import.meta.url).href}?iso13=${String(process.hrtime.bigint())}`
  )) as typeof import("../../../src/lib/capture/l1-cache-key.js");

  const base = {
    engineKey: "perplexity",
    adapterMajor: 3,
    promptText: "best crm for small business",
    locale: "en-US",
    personaHint: null,
    ttlSeconds: 86_400,
    nowMs: 1_700_000_000_000,
  };

  const staging = keys.captureL1Key({ ...base, env: "staging" });
  const production = keys.captureL1Key({ ...base, env: "production" });

  // Half one — it carries the deployment namespace. Without it two
  // environments sharing a cache instance serve each other's answers, which
  // is the leak STORY-026 already found once on the socket.io channels.
  if (!staging.startsWith("staging:global:")) {
    throw new Error(
      `ISO-13 (shared answer cache): captureL1Key() must open with "{env}:global:" — got "${staging}"`,
    );
  }
  if (staging === production) {
    throw new Error(
      "ISO-13 (shared answer cache): captureL1Key() produces the SAME key for two deployments — " +
        "staging and production sharing one cache instance would serve each other's captured answers",
    );
  }

  // Half two — it does NOT vary by tenant. This is what makes the exemption
  // sound: §10 excepts this namespace from tenant scoping precisely because
  // the value carries no tenant data. A key that varied per workspace would
  // both break that premise and silently destroy the cross-tenant sharing
  // that is the whole point of the cache.
  const asA = keys.captureL1Key({ ...base, env: "test", workspaceId: "ws-a" } as never);
  const asB = keys.captureL1Key({ ...base, env: "test", workspaceId: "ws-b" } as never);
  if (asA !== asB) {
    throw new Error(
      "ISO-13 (shared answer cache): captureL1Key() varies by workspace — the exemption in §10 holds only " +
        "while this value carries NO tenant data, and a per-tenant key also destroys the sharing it exists for",
    );
  }
}

export async function assertIso13CacheNamespacing(): Promise<void> {
  await assertTenantKeyConstructors();
  await assertSharedAnswerCacheExemption();
  await assertRealtimeChannelNamespacing();

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

// ONE BREAKER PER ENTRY (test/isolation/meta/breaker-matrix.spec.ts enforces
// it), and it stays on the tenant boundary rather than moving to the realtime
// half added in STORY-026. Both properties are real, but a workspace id
// missing from a cache key crosses TENANTS, while a deployment namespace
// missing from a channel crosses ENVIRONMENTS — the first is the graver of the
// two, and the one this suite exists for. The realtime half is verified
// non-vacuous by mutation instead, recorded in the STORY-026 review notes.
//
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

