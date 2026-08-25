import { Global, Logger, Module } from "@nestjs/common";
import { loadEnv } from "../../config/env.js";
import { CACHE, type Cache } from "./cache.port.js";
import { InMemoryCacheAdapter } from "./in-memory-cache.adapter.js";
import { ValkeyCacheAdapter } from "./valkey-cache.adapter.js";

// STORY-025 T14/T16 — the CACHE provider.
//
// `@Global()` for the same reason DbModule's PG_POOL is shared: the cache is
// infrastructure that several unrelated mechanisms reach for (idempotency
// records now, token buckets next, membership memoisation later), and making
// each of them import a module to get it would spread the wiring rather than
// centralise it.
//
// TWO ADAPTERS, ONE PORT, AND THE CHOICE IS BY ENVIRONMENT — never by
// availability. A factory that fell back to the in-memory adapter when Valkey
// was unreachable would turn an outage into a correctness failure: with more
// than one API instance, two requests bearing the same idempotency key land on
// different processes, each find no record, and both execute. That is the
// double effect `NFR-API-07` exists to prevent, and it would happen silently.
// So the only thing that selects the adapter is NODE_ENV, and a Valkey that
// cannot be reached is a failed boot rather than a quiet downgrade.
//
// The two are not assumed to agree. test/integration/cache-port-conformance
// .spec.ts runs ONE suite against BOTH — including the concurrent-claim race
// and the non-sliding window — so a behavioural difference is a test failure
// rather than a production surprise.
const logger = new Logger("cache");

@Global()
@Module({
  providers: [
    {
      provide: CACHE,
      useFactory: async (): Promise<Cache> => {
        const env = loadEnv();

        if (env.NODE_ENV === "test") {
          // Deliberate, and the only environment that gets it: a unit suite
          // must not need a container to construct the composition root.
          return new InMemoryCacheAdapter();
        }

        const adapter = new ValkeyCacheAdapter(env.VALKEY_CACHE_URL);
        await adapter.connect();
        logger.log({ message: "cache connected", adapter: "valkey" });
        return adapter;
      },
    },
  ],
  exports: [CACHE],
})
export class CacheModule {}
