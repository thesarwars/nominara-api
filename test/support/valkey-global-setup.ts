import { startValkey, startValkeyFixture, type StartedValkey, type ValkeyFixture } from "./valkey-fixture.js";
import {
  HARNESS_CONTAINERS,
  TEST_CACHE_REDIS_URL_ENV,
  TEST_QUEUE_REDIS_URL_ENV,
  TEST_VALKEY_HARNESS_ENV,
  assertNotADeveloperService,
} from "./test-valkey.js";

// STORY-174 — vitest globalSetup for `pnpm test:integration`: one throwaway
// queue Valkey (noeviction, as BullMQ requires) and one throwaway cache Valkey
// (allkeys-lru), shared by the whole run, exactly as test/isolation/support/
// global-setup.ts shares one Postgres. Specs that need a private instance still
// start their own through valkey-fixture.ts; the shared pair is for the ones
// that merely boot the app against "a" Valkey.
//
// Isolation between spec files is the setup file's job (test-valkey-env.ts
// flushes BOTH instances before every file), and the files run serially.
//
// The URLs travel through process.env, which the forked workers inherit.

let queue: ValkeyFixture | undefined;
let cache: StartedValkey | undefined;

export default async function setup(): Promise<() => Promise<void>> {
  const results = await Promise.allSettled([startValkeyFixture(), startValkey()]);
  if (results[0].status === "fulfilled") queue = results[0].value;
  if (results[1].status === "fulfilled") cache = results[1].value;
  if (queue === undefined || cache === undefined) {
    // One started and one did not: stop the survivor, or it leaks past the run.
    await Promise.all([queue?.stop(), cache?.stop()]);
    const failure = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    throw failure?.reason instanceof Error ? failure.reason : new Error("Valkey harness failed to start");
  }
  assertNotADeveloperService(TEST_QUEUE_REDIS_URL_ENV, queue.connectionString);
  assertNotADeveloperService(TEST_CACHE_REDIS_URL_ENV, cache.url);
  process.env[TEST_QUEUE_REDIS_URL_ENV] = queue.connectionString;
  process.env[TEST_VALKEY_HARNESS_ENV] = HARNESS_CONTAINERS;
  process.env[TEST_CACHE_REDIS_URL_ENV] = cache.url;

  return async () => {
    await Promise.all([queue?.stop(), cache?.stop()]);
  };
}
