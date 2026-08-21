import { Test } from "@nestjs/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspacesModule } from "./workspaces.module.js";
import { WorkspacesController } from "./workspaces.controller.js";

// STORY-022 — one compiles-test per scaffolded module (task 6 of this
// story's breakdown). STORY-021 extended WorkspacesModule to import
// IdentityModule (SessionService needs PG_POOL) and add the DEK_PROVISIONER
// factory (needs WORKSPACE_DEK_WRAPPING_KEY/WORKSPACE_KMS_KEY_ARN), both of
// which eagerly validate the full env schema at .compile() time — same env
// fixture every other composition-root spec uses (identity.spec.ts's own
// comment explains why).
describe("STORY-022 · WorkspacesModule compiles", () => {
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

  it("resolves in a Nest testing module", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [WorkspacesModule] }).compile();
    expect(moduleRef.get(WorkspacesController)).toBeInstanceOf(WorkspacesController);
    await moduleRef.close();
  });
});
