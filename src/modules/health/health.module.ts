import { Module } from "@nestjs/common";
import { TerminusModule } from "@nestjs/terminus";
import { Redis } from "ioredis";
import { loadEnv } from "../../config/env.js";
import { MIGRATIONS_DIR } from "../../db/migrate-runner.js";
import { createQueueReaderConnection, queueKeyPrefix } from "../../lib/queue/connection.js";
import { HealthController } from "./health.controller.js";
import {
  CACHE_CONNECTION_TOKEN,
  HealthService,
  MIGRATIONS_DIR_TOKEN,
  QUEUE_CONNECTION_TOKEN,
  QUEUE_KEY_PREFIX_TOKEN,
} from "./health.service.js";

// STORY-030 Task 28 — the queue instance's dedicated Valkey connection
// (system-architecture.md §11), read-only here: HealthService only checks
// depth, it never runs a Worker.
//
// STORY-031 Phase I — STORY-025's cache Valkey instance, ALSO read-only here
// (HealthService only reads breaker state for readiness's engines[], D16 —
// it never itself opens/closes a breaker). `lazyConnect: true` avoids an
// eager connection attempt merely from construction (same choice
// worker.ts's canary wiring makes); a short `connectTimeout` plus a bounded
// `retryStrategy` means a genuinely unreachable cache instance fails within
// about a second rather than hanging a health check on ioredis's default
// (much more patient) reconnection budget.
function createHealthCacheConnection(url: string): Redis {
  const redis = new Redis(url, {
    lazyConnect: true,
    connectTimeout: 500,
    retryStrategy: (times) => (times > 1 ? null : 200),
  });
  redis.on("error", () => {
    // Swallowed deliberately — every read call already handles its own
    // failure; an unhandled 'error' event here would otherwise crash the
    // process on a background reconnect attempt.
  });
  return redis;
}

@Module({
  imports: [TerminusModule],
  controllers: [HealthController],
  providers: [
    HealthService,
    { provide: MIGRATIONS_DIR_TOKEN, useValue: MIGRATIONS_DIR },
    { provide: QUEUE_CONNECTION_TOKEN, useFactory: (): Redis => createQueueReaderConnection(loadEnv().QUEUE_REDIS_URL) },
    { provide: QUEUE_KEY_PREFIX_TOKEN, useFactory: (): string => queueKeyPrefix(loadEnv().NODE_ENV) },
    { provide: CACHE_CONNECTION_TOKEN, useFactory: (): Redis => createHealthCacheConnection(loadEnv().VALKEY_CACHE_URL) },
  ],
})
export class HealthModule {}
