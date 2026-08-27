import "reflect-metadata";
import { pathToFileURL } from "node:url";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { loadEnv } from "./config/env.js";
import { RealtimeModule } from "./gateway/gateway.module.js";
import { RealtimeGateway } from "./gateway/realtime.gateway.js";
import { cacheKeyNamespace } from "./lib/cache/key-namespace.js";
import { realtimeControlChannel, realtimeFanoutChannel } from "./lib/cache/realtime-publisher.js";

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

  // STORY-026 T22 — AC4. Without the adapter a broadcast reaches only the
  // sockets attached to THIS replica, so with two gateways half the events
  // silently do not arrive. That looks like a flaky product rather than a
  // missing adapter, and the usual "fix" — sticky sessions — makes a rolling
  // deploy disconnect every pinned client at once.
  // Skipped under the test runner for the same reason the cache adapter is:
  // a unit suite must not need a Valkey to boot the process. Chosen by
  // ENVIRONMENT, never by availability — a gateway that quietly ran without
  // the adapter because Valkey was unreachable would deliver events to one
  // replica's sockets and silently drop them for every other client, which
  // looks like a flaky product rather than a failed dependency.
  if (env.NODE_ENV === "test" && process.env.VITEST === undefined) {
    // NOT ON THE WORD OF NODE_ENV ALONE — see `cache.module.ts` and
    // `RealtimePublisherProvider.create()`, which now carry the same guard.
    // A preview or ephemeral deploy running NODE_ENV=test would start a
    // gateway with no adapter and no control channel: events reach only the
    // replica that emitted them, and a revoked member keeps a socket for the
    // full sixty seconds. Both silently. Found in the STORY-026 review.
    throw new Error(
      "gateway: NODE_ENV=test skips the Valkey adapter and the control channel, but no test runner is present. " +
        "That gateway would broadcast to one replica only and could not revoke a socket before the 60s timer. " +
        "Set NODE_ENV appropriately for this deployment, or run under the test runner.",
    );
  }
  if (env.NODE_ENV !== "test") {
    const gateway = app.get(RealtimeGateway);
    gateway.attachAdapter(env.VALKEY_CACHE_URL);
    // The control channel is what makes `member.changed` close a socket rather
    // than merely inform a client. Without it the only thing closing a revoked
    // socket is the sixty-second timer.
    gateway.attachControlChannel(env.VALKEY_CACHE_URL, realtimeControlChannel(cacheKeyNamespace()));
    // The channel client events arrive on. Without it this instance holds
    // sockets and delivers nothing to them — the adapter no longer carries
    // §11's events, because a room broadcast cannot honour §11's coalescing
    // or §9's per-socket cap.
    gateway.attachFanoutChannel(env.VALKEY_CACHE_URL, realtimeFanoutChannel(cacheKeyNamespace()));
  }
  new Logger("bootstrap").log(`gateway listening on :${env.GATEWAY_PORT}`);
  return app;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void bootstrapGateway();
}
