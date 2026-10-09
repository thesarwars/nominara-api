import net from "node:net";
import { afterAll, beforeAll } from "vitest";
import { Redis } from "ioredis";
import { installConnectTripwire } from "./connect-tripwire.js";
import {
  HARNESS_CONTAINERS,
  INERT_CACHE_REDIS_URL,
  INERT_QUEUE_REDIS_URL,
  REFUSED_CONNECTIONS_KEY,
  TEST_CACHE_REDIS_URL_ENV,
  TEST_QUEUE_REDIS_URL_ENV,
  TEST_VALKEY_HARNESS_ENV,
  assertNotADeveloperService,
  isDeveloperServiceTarget,
} from "./test-valkey.js";

// STORY-174 — vitest setupFile, run in every worker of all three configs.
// Three jobs, in order:
//
// 1. Make the app's two connection variables unable to carry a developer's
//    value. The ambient QUEUE_REDIS_URL / VALKEY_CACHE_URL (a developer's shell
//    often exports the docker-compose ones) are removed, so a spec that forgets
//    to set them fails loudly in loadEnv() instead of connecting to whatever
//    the shell said. src/ has no default for either (env.schema.ts), so there
//    is no silent fallback to scrub — only an inherited value to refuse.
//
// 2. Provide the harness URLs: from the integration globalSetup if it ran,
//    otherwise INERT ones (unit, isolation).
//
// 3. A runtime tripwire — the static guard (test/unit/test-valkey-guard.spec.ts)
//    reads source text and cannot see an address built at run time. Any TCP
//    connect to loopback on a developer-service port is refused, recorded, and
//    fails the file at afterAll even if the code under test swallowed the error
//    in a retry loop (ioredis does).

delete process.env.QUEUE_REDIS_URL;
delete process.env.VALKEY_CACHE_URL;

const containers = process.env[TEST_VALKEY_HARNESS_ENV] === HARNESS_CONTAINERS;
if (!containers) {
  // No harness containers in this run: ignore whatever the shell exported.
  process.env[TEST_QUEUE_REDIS_URL_ENV] = INERT_QUEUE_REDIS_URL;
  process.env[TEST_CACHE_REDIS_URL_ENV] = INERT_CACHE_REDIS_URL;
}
for (const name of [TEST_QUEUE_REDIS_URL_ENV, TEST_CACHE_REDIS_URL_ENV]) {
  assertNotADeveloperService(name, process.env[name] ?? "");
}

// Shared through a registry symbol, not an import: the tripwire's own spec
// must be able to take (and so acknowledge) the refusal it provokes on purpose.
const refused: string[] = ((globalThis as Record<symbol, unknown>)[REFUSED_CONNECTIONS_KEY] ??= []) as string[];
installConnectTripwire(net.Socket.prototype, (t) => isDeveloperServiceTarget(t.host, t.port), (m) => refused.push(m));

// Integration only: the shared containers outlive every file, so each file
// starts from an empty keyspace on both. They are OURS (globalSetup just
// started them), which is the only reason flushing them is acceptable.
beforeAll(async () => {
  if (!containers) return;
  for (const name of [TEST_QUEUE_REDIS_URL_ENV, TEST_CACHE_REDIS_URL_ENV]) {
    const client = new Redis(process.env[name] as string, { maxRetriesPerRequest: 1 });
    try {
      await client.flushall();
    } finally {
      client.disconnect();
    }
  }
});

afterAll(() => {
  if (refused.length > 0) {
    throw new Error(`STORY-174 tripwire:\n${[...new Set(refused)].join("\n")}`);
  }
});
