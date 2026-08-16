import "reflect-metadata";
import { pathToFileURL } from "node:url";
import { Logger, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { INestApplicationContext } from "@nestjs/common";
import { loadEnv } from "./config/env.js";

// STORY-022 — worker bootstrap (project-structure.md §2: "src/worker.ts
// worker bootstrap; WORKER_GROUP selects the queue set"). Actual BullMQ
// queue/processor wiring (src/workers/{capture,parse,crawl,embed,rollup,
// report}/) lands in STORY-030 — this story only selects, validates, and
// logs the group, then boots a Nest application context with shutdown
// hooks so the process participates correctly in a rolling deploy.
export class WorkerGroupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerGroupError";
  }
}

@Module({})
class WorkerRootModule {}

export async function bootstrapWorker(): Promise<INestApplicationContext> {
  const env = loadEnv();
  if (!env.WORKER_GROUP) {
    throw new WorkerGroupError(
      "WORKER_GROUP must be set to boot a worker process (capture|parse|crawl|embed|rollup|report)",
    );
  }

  const app = await NestFactory.createApplicationContext(WorkerRootModule, { bufferLogs: true });
  app.enableShutdownHooks();
  new Logger("bootstrap").log(`worker group "${env.WORKER_GROUP}" started (queue wiring: STORY-030)`);
  return app;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void bootstrapWorker();
}
