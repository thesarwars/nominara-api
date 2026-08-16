import "reflect-metadata";
import { pathToFileURL } from "node:url";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { loadEnv } from "./config/env.js";
import { RealtimeModule } from "./gateway/gateway.module.js";

// STORY-022 — WebSocket gateway bootstrap (project-structure.md §2:
// "src/gateway.ts WebSocket gateway bootstrap"). A separate process/port
// from src/main.ts, matching the deployment topology's standalone
// svc-gateway service. Cold start bound at <=8s (NFR-ARCH-06).
export async function bootstrapGateway(): Promise<NestFastifyApplication> {
  const env = loadEnv();
  const app = await NestFactory.create<NestFastifyApplication>(RealtimeModule, new FastifyAdapter(), {
    bufferLogs: true,
  });
  app.enableShutdownHooks();
  await app.listen({ port: env.GATEWAY_PORT, host: "0.0.0.0" });
  new Logger("bootstrap").log(`gateway listening on :${env.GATEWAY_PORT}`);
  return app;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void bootstrapGateway();
}
