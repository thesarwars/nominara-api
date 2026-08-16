import { createServer } from "node:net";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { io, type Socket } from "socket.io-client";
import { afterEach, describe, expect, it } from "vitest";
import { RealtimeModule } from "../../src/gateway/gateway.module.js";
import { SERVER_DRAINING_EVENT } from "../../src/gateway/realtime.gateway.js";

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

// STORY-022 · NFR-ARCH-07 — "WebSocket clients receive server.draining and
// reconnect with jitter" on a rolling deploy. A real socket.io-client
// connects to the /rt namespace over an actual TCP port; app.close() is
// the same shutdown path a SIGTERM (via enableShutdownHooks()) triggers.
describe("STORY-022 · gateway shutdown draining", () => {
  let app: NestFastifyApplication | undefined;
  let client: Socket | undefined;

  afterEach(async () => {
    client?.disconnect();
    await app?.close().catch(() => undefined);
    app = undefined;
    client = undefined;
  });

  it("emits server.draining to a connected /rt client before the process shuts down", async () => {
    const port = await getFreePort();
    app = await NestFactory.create<NestFastifyApplication>(RealtimeModule, new FastifyAdapter());
    await app.listen({ port, host: "127.0.0.1" });

    client = io(`http://127.0.0.1:${port}/rt`, { transports: ["websocket"] });
    await new Promise<void>((resolve, reject) => {
      client!.on("connect", () => resolve());
      client!.on("connect_error", reject);
    });

    let receivedDraining = false;
    const drained = new Promise<void>((resolve) => {
      client!.on(SERVER_DRAINING_EVENT, () => {
        receivedDraining = true;
        resolve();
      });
    });

    await app.close();
    await drained;

    expect(receivedDraining).toBe(true);
  });
});
