// STORY-174 — the ONE place a test learns where its Valkey is.
//
// Before this story ~40 spec files assigned a loopback URL on the docker-compose
// development ports to VALKEY_CACHE_URL / QUEUE_REDIS_URL, so on a developer
// machine every `test:unit` / `test:integration` run connected to the
// developer's own running Valkey (their BullMQ queue, their workers' prefix)
// and left `nominara-queue-test:*` keys in it. Postgres never had this problem
// because testcontainers owns it; Valkey now follows the same pattern.
//
// Contract, per vitest project:
//   test:integration  globalSetup (valkey-global-setup.ts) starts ONE throwaway
//                     queue instance + ONE throwaway cache instance and exports
//                     their URLs through the two env vars below.
//   test:unit, test:isolation
//                     no container. The setup file (test-valkey-env.ts) exports
//                     INERT URLs: a reserved `.invalid` host (RFC 2606), which
//                     cannot resolve and so cannot reach any service. A unit
//                     spec needs a URL that PARSES, never one that connects.
//
// A spec reads the URL through `testQueueRedisUrl()` / `testCacheRedisUrl()`.
// Neither has a fallback: an unset variable throws, because a default address
// is exactly how a test ends up talking to the wrong server.

export const TEST_QUEUE_REDIS_URL_ENV = "NOMINARA_TEST_QUEUE_REDIS_URL";
export const TEST_CACHE_REDIS_URL_ENV = "NOMINARA_TEST_CACHE_REDIS_URL";

/** Set by the integration globalSetup only: the two URLs above are LIVE throwaway containers (flush them between files). */
export const TEST_VALKEY_HARNESS_ENV = "NOMINARA_TEST_VALKEY_HARNESS";
export const HARNESS_CONTAINERS = "containers";

/** Reserved TLD (RFC 2606): never resolves, so a client given it connects to nothing. */
export const INERT_QUEUE_REDIS_URL = "redis://queue-valkey.test.invalid";
export const INERT_CACHE_REDIS_URL = "redis://cache-valkey.test.invalid";

/**
 * A Valkey that is guaranteed to REFUSE the connection, for the specs whose
 * point is how the code behaves when Valkey is down. Port 1 (tcpmux) on
 * loopback is not a service anyone runs; nothing leaves the machine and nothing
 * can answer. This literal is the single allow-listed one in the guard
 * (test/unit/test-valkey-guard.spec.ts) — every spec imports it from here.
 */
export const DEAD_VALKEY_URL = "redis://127.0.0.1:1";

/** Ports a developer's own Valkey/redis conventionally listens on. */
export const DEVELOPER_VALKEY_PORTS: ReadonlySet<number> = new Set([6379, 6380, 56379]);

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

export function isDeveloperServiceTarget(host: string, port: number): boolean {
  return isLoopbackHost(host) && DEVELOPER_VALKEY_PORTS.has(port);
}

export function isLoopbackHost(host: string): boolean {
  const lower = host.toLowerCase();
  return LOOPBACK_HOSTS.has(lower) || /^127\.\d+\.\d+\.\d+$/.test(lower) || lower.endsWith(".localhost");
}

/** Throws if `url` addresses the loopback interface on a developer-service port. */
export function assertNotADeveloperService(name: string, url: string): void {
  const parsed = new URL(url);
  const port = parsed.port === "" ? 6379 : Number(parsed.port);
  if (isDeveloperServiceTarget(parsed.hostname, port)) {
    throw new Error(
      `${name}=${url} addresses a developer service port on this machine. Tests own their Valkey (STORY-174): ` +
        "use the testcontainers harness URL, never a docker-compose or Homebrew instance.",
    );
  }
}

function fromEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(
      `${name} is not set. It is exported by the test harness (valkey-global-setup.ts for integration, ` +
        "test-valkey-env.ts for unit/isolation); a test never falls back to a default address (STORY-174).",
    );
  }
  assertNotADeveloperService(name, value);
  return value;
}

/** The queue (BullMQ) Valkey URL for this test run. Throws if the harness did not provide one. */
export function testQueueRedisUrl(): string {
  return fromEnv(TEST_QUEUE_REDIS_URL_ENV);
}

/** The cache Valkey URL for this test run. Throws if the harness did not provide one. */
export function testCacheRedisUrl(): string {
  return fromEnv(TEST_CACHE_REDIS_URL_ENV);
}

/** Registry key of the tripwire's list of refused connections (test-valkey-env.ts). */
export const REFUSED_CONNECTIONS_KEY = Symbol.for("nominara.test.refusedDeveloperConnections");
