import { Controller, Get, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterEach, describe, expect, it } from "vitest";

// A minimal in-flight-request probe, not the full ApiModule — the behavior
// under test (Nest's enableShutdownHooks() -> app.close() draining Fastify's
// live connections, per src/main.ts) is generic to any Nest/Fastify app and
// doesn't depend on ApiModule's own routes or guard chain.
const DELAY_MS = 300;

@Controller()
class SlowController {
  @Get("slow")
  async slow(): Promise<{ ok: true }> {
    await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
    return { ok: true };
  }
}

@Module({ controllers: [SlowController] })
class SlowModule {}

async function bootSlowApp(): Promise<{ app: NestFastifyApplication; url: string }> {
  const app = await NestFactory.create<NestFastifyApplication>(SlowModule, new FastifyAdapter(), {
    logger: false,
  });
  app.enableShutdownHooks();
  await app.listen({ port: 0, host: "127.0.0.1" });
  return { app, url: await app.getUrl() };
}

// STORY-022 · Test Scenario 7 — "send shutdown -> connections drain" on the
// HTTP side of src/main.ts's app.enableShutdownHooks(). app.close() here is
// the exact call Nest's SIGTERM/SIGINT listener (wired by
// enableShutdownHooks()) invokes.
describe("STORY-022 · HTTP shutdown draining", () => {
  let app: NestFastifyApplication | undefined;

  afterEach(async () => {
    await app?.close().catch(() => undefined);
    app = undefined;
  });

  it("completes a request already in-flight when shutdown begins", async () => {
    const booted = await bootSlowApp();
    app = booted.app;

    // Connection: close — without it the client's keep-alive socket stays
    // open after the response and Fastify's close() waits indefinitely for
    // it, which isn't what a real draining proxy connection does.
    const inFlight = fetch(`${booted.url}/slow`, { headers: { connection: "close" } });
    await new Promise((resolve) => setTimeout(resolve, DELAY_MS / 3));

    const closePromise = app.close();
    const response = await inFlight;

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });

    await closePromise;
    app = undefined;
  });

  it("rejects a request arriving after shutdown has begun, instead of hanging", async () => {
    const booted = await bootSlowApp();
    app = booted.app;

    await app.close();
    app = undefined;

    await expect(fetch(`${booted.url}/slow`)).rejects.toThrow();
  });
});
