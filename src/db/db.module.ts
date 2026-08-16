import { Global, Inject, Module, type OnModuleDestroy } from "@nestjs/common";
import type { Pool } from "pg";
import { loadEnv } from "../config/env.js";
import { createPgPool, PG_POOL } from "./pg-pool.js";

// STORY-022 — the pooled Postgres connection (through pgBouncer, per
// .env.example's DATABASE_URL_POOLED), provided once and exported globally
// so any module (HealthModule, the api composition root's
// TenantContextInterceptor) can @Inject(PG_POOL) without importing this
// module directly. A full DrizzleService (project-structure.md §2) is a
// later story's job.
@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      useFactory: (): Pool => createPgPool(loadEnv().DATABASE_URL_POOLED),
    },
  ],
  exports: [PG_POOL],
})
export class DbModule implements OnModuleDestroy {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  // Runs as part of app.close() during graceful shutdown (src/main.ts's
  // enableShutdownHooks), AFTER in-flight requests have drained — never
  // abruptly under a request.
  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
