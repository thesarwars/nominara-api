import "reflect-metadata";
import { pathToFileURL } from "node:url";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { ApiModule } from "./api/api.module.js";
import { configureApp } from "./api/configure-app.js";
import { loadEnv } from "./config/env.js";

// STORY-022 — API bootstrap (project-structure.md §2: "src/main.ts API
// bootstrap (Fastify adapter)"). enableShutdownHooks() wires SIGTERM/SIGINT
// into Nest's lifecycle (onModuleDestroy etc.) for NFR-ARCH-07's rolling
// deploys. Cold start is bound at <=8s by NFR-ARCH-06 (main.spec.ts).
//
// STORY-023 (D1) — global prefix + cookie plugin now live in configureApp(),
// the shared seam every test assembly site also calls.
export async function bootstrap(): Promise<NestFastifyApplication> {
  const env = loadEnv();
  const app = await NestFactory.create<NestFastifyApplication>(ApiModule, new FastifyAdapter(), {
    bufferLogs: true,
  });
  app.enableShutdownHooks();
  await configureApp(app);
  await app.listen({ port: env.PORT, host: "0.0.0.0" });
  new Logger("bootstrap").log(`API listening on :${env.PORT}`);
  return app;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void bootstrap();
}
