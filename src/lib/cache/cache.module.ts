import { Global, Logger, Module } from "@nestjs/common";
import { loadEnv } from "../../config/env.js";
import { CACHE, type Cache } from "./cache.port.js";
import { InMemoryCacheAdapter } from "./in-memory-cache.adapter.js";

// STORY-025 T14/T16 — the CACHE provider.
//
// `@Global()` for the same reason DbModule's PG_POOL is shared: the cache is
// infrastructure that several unrelated mechanisms reach for (idempotency
// records now, token buckets next, membership memoisation later), and making
// each of them import a module to get it would spread the wiring rather than
// centralise it.
//
// *** DISCLOSED GAP — THIS IS NOT PRODUCTION-READY. ***
// The production adapter is Valkey over `ioredis`, approved as decision D3 of
// the EPIC-03 execution plan. `pnpm add ioredis` was REFUSED by this
// environment's command classifier, so the adapter does not exist yet and the
// in-memory one is what is wired.
//
// The in-memory adapter is per-process. With more than one API instance, two
// requests bearing the same idempotency key can land on different processes,
// each find no record, and both execute — which is precisely the double
// effect `NFR-API-07` exists to prevent. It is correct for tests and for a
// single-process development run, and wrong for anything else.
//
// So this fails closed rather than shipping quietly: production refuses to
// boot, and every other environment logs what it is using on every start. The
// alternative — wiring it silently and writing the gap in a README — is how a
// per-process cache reaches production with every gate green.
const logger = new Logger("cache");

@Global()
@Module({
  providers: [
    {
      provide: CACHE,
      useFactory: (): Cache => {
        const env = loadEnv();
        if (env.NODE_ENV === "production") {
          throw new Error(
            "cache: the Valkey adapter is not implemented (ioredis is not installed), and the in-memory " +
              "adapter is PER-PROCESS. Two API instances would each miss the other's idempotency records and " +
              "both execute the same billable request. Refusing to start rather than serve production from it.",
          );
        }
        logger.warn({
          message: "using the in-memory cache adapter — per-process, not shared, NOT production-safe",
          valkey_cache_url_configured: env.VALKEY_CACHE_URL.length > 0,
        });
        return new InMemoryCacheAdapter();
      },
    },
  ],
  exports: [CACHE],
})
export class CacheModule {}
