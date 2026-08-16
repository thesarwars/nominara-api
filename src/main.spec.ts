import { createServer } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootstrap } from "./main.js";

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

// STORY-022 — NFR-ARCH-06: "Cold start <= 8s." Exercises the real
// bootstrap() function (FastifyAdapter + full ApiModule graph), not a
// stand-in, listening on an OS-assigned free port.
describe("STORY-022 · main.ts cold start", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.DATABASE_URL = "postgres://fake:fake@localhost:5432/fake";
    process.env.DATABASE_URL_POOLED = "postgres://fake:fake@localhost:5432/fake";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("boots the full API composition root and starts listening in under 8s", async () => {
    process.env.PORT = String(await getFreePort());

    const start = performance.now();
    const app = await bootstrap();
    const elapsedMs = performance.now() - start;

    expect(elapsedMs).toBeLessThan(8000);

    await app.close();
  }, 15_000);
});
