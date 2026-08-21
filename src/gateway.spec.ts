import { createServer } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootstrapGateway } from "./gateway.js";

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

// STORY-022 — NFR-ARCH-06: "Cold start <= 8s," applied to the WebSocket
// gateway's own bootstrap.
describe("STORY-022 · gateway.ts cold start", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.DATABASE_URL = "postgres://fake:fake@localhost:5432/fake";
    process.env.DATABASE_URL_POOLED = "postgres://fake:fake@localhost:5432/fake";
    process.env.WEBAUTHN_RP_ID = "localhost";
    process.env.WEBAUTHN_RP_NAME = "Nominara";
    process.env.WEBAUTHN_ORIGIN = "http://localhost:3000";
    process.env.AUTH_TOKEN_ED25519_PRIVATE_KEY = "MC4CAQAwBQYDK2VwBCIEIDBtSyhPpdvfpMewjjRZhs0QItLs53aiIaned1RhI6d1";
    process.env.AUTH_TOKEN_ED25519_PUBLIC_KEY = "MCowBQYDK2VwAyEAYbvU26OMhfsHxRMPLxXokTTSWtx06/lxhf1L0gnFBoM=";
    process.env.AUTH_TOKEN_ED25519_KID = "test-kid-1";
    process.env.CSRF_SECRET = "test-csrf-secret";
    process.env.WORKSPACE_DEK_WRAPPING_KEY = Buffer.alloc(32, 7).toString("base64");
    process.env.OAUTH_REDIRECT_BASE_URL = "http://localhost:3000";
    process.env.OAUTH_STATE_SECRET = "test-oauth-state-secret";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("boots the realtime gateway and starts listening in under 8s", async () => {
    process.env.GATEWAY_PORT = String(await getFreePort());

    const start = performance.now();
    const app = await bootstrapGateway();
    const elapsedMs = performance.now() - start;

    expect(elapsedMs).toBeLessThan(8000);

    await app.close();
  }, 15_000);
});
