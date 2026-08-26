import { Module } from "@nestjs/common";
import { TerminusModule } from "@nestjs/terminus";
import type { Redis } from "ioredis";
import { loadEnv } from "../../config/env.js";
import { MIGRATIONS_DIR } from "../../db/migrate-runner.js";
import { createQueueConnection, queueKeyPrefix } from "../../lib/queue/connection.js";
import { HealthController } from "./health.controller.js";
import { HealthService, MIGRATIONS_DIR_TOKEN, QUEUE_CONNECTION_TOKEN, QUEUE_KEY_PREFIX_TOKEN } from "./health.service.js";

// STORY-030 Task 28 — the queue instance's dedicated Valkey connection
// (system-architecture.md §11), read-only here: HealthService only checks
// depth, it never runs a Worker.
@Module({
  imports: [TerminusModule],
  controllers: [HealthController],
  providers: [
    HealthService,
    { provide: MIGRATIONS_DIR_TOKEN, useValue: MIGRATIONS_DIR },
    { provide: QUEUE_CONNECTION_TOKEN, useFactory: (): Redis => createQueueConnection(loadEnv().QUEUE_REDIS_URL) },
    { provide: QUEUE_KEY_PREFIX_TOKEN, useFactory: (): string => queueKeyPrefix(loadEnv().NODE_ENV) },
  ],
})
export class HealthModule {}
