import { Test } from "@nestjs/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IdentityModule } from "./identity.module.js";
import { IdentityController } from "./identity.controller.js";

// STORY-014 — IdentityModule now imports DbModule (needed for
// IdentityService's @Inject(PG_POOL)), which eagerly constructs PG_POOL at
// .compile() time and therefore validates the full env schema — this smoke
// test needs the same env fixture every other composition-root spec uses.
describe("STORY-014 · IdentityModule compiles", () => {
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
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("resolves in a Nest testing module", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [IdentityModule] }).compile();
    expect(moduleRef.get(IdentityController)).toBeInstanceOf(IdentityController);
    await moduleRef.close();
  });
});
