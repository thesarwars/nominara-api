import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ApiModule } from "../../src/api/api.module.js";
import { configureApp } from "../../src/api/configure-app.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { applyFakeApiEnv } from "../support/fake-env.js";
import { ACCESS_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "../../src/lib/auth/cookies.js";
import { computeCsrfToken } from "../../src/lib/auth/csrf.js";
import { SessionService } from "../../src/modules/identity/session.service.js";
import { apiUrl } from "../support/api-url.js";

// STORY-023 T2 (RED step) — Test scenario 8 ("Send an unknown key to any
// endpoint -> validation failure") and AC8 ("The specification is served
// from a documented route so a consumer can fetch it").
//
// *** THIS FILE IS DELIBERATELY MIXED — read each `describe` label before
// treating a green result as this task's RED step working. ***
//
//   PART A (characterization — ALREADY GREEN today, not new RED): POST
//   /v1/workspaces already binds ZodValidationPipe(createWorkspaceRequestSchema)
//   (STORY-021), and that schema is already `.strict()`. This locks EXISTING
//   behaviour over the real HTTP pipeline so nothing regresses it later — it
//   is not evidence that this task's RED step did anything.
//
//   PART B (genuinely RED today): GET /v1/openapi.json does not exist until
//   task T3 wires src/contracts/serve.ts + src/api/register-openapi.ts
//   (both deliberately not created by this RED step).
//
// Same real-Postgres / real-deployed-ApiModule / real-HTTP pattern as
// test/integration/workspace-mutations-audit.spec.ts (this story's own
// "through the real, deployed ApiModule" precedent) — nothing here stubs a
// guard, interceptor, or pipe.

const PRIVATE_KEY_DER = "MC4CAQAwBQYDK2VwBCIEIDBtSyhPpdvfpMewjjRZhs0QItLs53aiIaned1RhI6d1";
const PUBLIC_KEY_DER = "MCowBQYDK2VwAyEAYbvU26OMhfsHxRMPLxXokTTSWtx06/lxhf1L0gnFBoM=";
const KID = "test-kid-1";
const CSRF_SECRET = "test-csrf-secret";
const WRAPPING_KEY = Buffer.alloc(32, 21);
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

describe("STORY-023 · GET /v1/openapi.json and the real POST /v1/workspaces strictness boundary", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let app: NestFastifyApplication;
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();
  }, 180_000);

  afterAll(async () => {
    await container.stop();
    process.env = { ...originalEnv };
  });

  beforeEach(async () => {
    // Every REQUIRED key first, from the one shared helper, so a new required
    // env var (STORY-016 added OTP_EMAIL_HASH_PEPPER and OTP_EMAIL_FROM) can
    // never again take this file down with an EnvValidationError raised inside
    // DbModule's PG_POOL factory. This file's own deliberate values — the
    // signing keys its assertions depend on, and the container URI — are
    // assigned AFTER, so they still win.
    applyFakeApiEnv();
    process.env.WEBAUTHN_RP_ID = "localhost";
    process.env.WEBAUTHN_RP_NAME = "Nominara";
    process.env.WEBAUTHN_ORIGIN = "http://localhost:3000";
    process.env.AUTH_TOKEN_ED25519_PRIVATE_KEY = PRIVATE_KEY_DER;
    process.env.AUTH_TOKEN_ED25519_PUBLIC_KEY = PUBLIC_KEY_DER;
    process.env.AUTH_TOKEN_ED25519_KID = KID;
    process.env.CSRF_SECRET = CSRF_SECRET;
    process.env.WORKSPACE_DEK_WRAPPING_KEY = WRAPPING_KEY.toString("base64");
    process.env.OAUTH_REDIRECT_BASE_URL = "http://localhost:3000";
    process.env.OAUTH_STATE_SECRET = "test-oauth-state-secret";
    process.env.DATABASE_URL = container.getConnectionUri();
    process.env.DATABASE_URL_POOLED = container.getConnectionUri();

    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await db.query("DROP SCHEMA IF EXISTS app CASCADE");
    await db.query("DROP SCHEMA IF EXISTS _migrations CASCADE");
    await db.query("DROP SCHEMA public CASCADE");
    await db.query("CREATE SCHEMA public");
    await migrateUp(db);

    const moduleRef = await Test.createTestingModule({ imports: [ApiModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await configureApp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  }, 60_000);

  afterEach(async () => {
    await app.close();
    await db.end();
  });

  async function createUser(email = `user-${randomUUID()}@example.com`): Promise<string> {
    const result = await db.query<{ id: string }>("INSERT INTO users (email) VALUES ($1) RETURNING id", [email]);
    return result.rows[0]!.id;
  }

  async function newSession() {
    const sessions = app.get(SessionService);
    const userId = await createUser();
    const tokens = await sessions.createSession(userId);
    const csrf = computeCsrfToken(tokens.sid, CSRF_SECRET);
    return { userId, ...tokens, csrf };
  }

  // ---- PART A — characterization, ALREADY GREEN today ----------------------

  it("PART A (characterization, already green — not new RED) — scenario 8: an unknown key on POST /v1/workspaces is refused 400, naming the offending key", async () => {
    const session = await newSession();

    const res = await app.inject({
      method: "POST",
      url: apiUrl("/workspaces"),
      cookies: { [ACCESS_COOKIE_NAME]: session.accessToken, [CSRF_COOKIE_NAME]: session.csrf },
      headers: { [CSRF_HEADER_NAME]: session.csrf },
      payload: { name: `Strict Co ${randomUUID()}`, mystery_field: "should never be silently accepted" },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json() as { detail?: string; message?: string };
    const message = body.detail ?? body.message ?? "";
    expect(message).toContain("mystery_field");
  });

  // ---- PART B — genuinely RED today ----------------------------------------

  it("PART B (genuinely red today) — AC8: GET /v1/openapi.json serves the generated document, including the worked example route", async () => {
    const res = await app.inject({ method: "GET", url: apiUrl("/openapi.json") });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { openapi?: string; paths?: Record<string, unknown> };
    expect(body.openapi).toMatch(/^3\.1\./);
    expect(body.paths?.["/v1/workspaces"]).toBeDefined();
  });

  // M6 (coordinator's code-review round 2) — src/contracts/serve.ts could
  // build something at RUNTIME that differs from the committed file
  // @nominara/client was actually generated from (e.g. re-deriving the
  // document on every request instead of serving the exact committed
  // bytes/object) — nothing above catches that. Deep-equal the served body
  // against the real contracts/openapi.generated.json on disk, and assert
  // the content type a consumer actually receives.
  it("PART B (genuinely red today) — the served document is byte-for-byte the SAME object as the committed contracts/openapi.generated.json, served with the correct content type", async () => {
    const res = await app.inject({ method: "GET", url: apiUrl("/openapi.json") });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^application\/json/);

    const committedPath = resolve(REPO_ROOT, "contracts/openapi.generated.json");
    // No committed document exists yet (task T3) — this throws (ENOENT),
    // the expected RED reason for this half of the test today.
    const committed = JSON.parse(readFileSync(committedPath, "utf8"));

    expect(res.json()).toEqual(committed);
  });
});
