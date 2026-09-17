import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { oauthLinkItemSchema } from "../../contracts/identity/oauth-link-response.schema.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { OauthService } from "../../src/modules/identity/oauth.service.js";
import { applyFakeApiEnv } from "../support/fake-env.js";

// STORY-096 slice C — `GET /me/oauth`, the state BETWEEN link and unlink.
//
// `POST /auth/oauth/{provider}/link/start` and `DELETE /me/oauth/{provider}`
// both shipped with STORY-015 and nothing could read what sat between them —
// so a security screen could offer "Connect" and "Disconnect" without knowing
// which of the two was the truthful control. `unlink` answers 403 for a
// provider that is not linked, so the wrong one is a button whose only
// outcome is an error.
//
// Exercised through the SERVICE against a real Postgres. What is asserted
// here is which rows it selects and which columns it publishes; the HTTP
// wiring is covered by the contract gate and the route-permission gate.

describe("STORY-096C · GET /me/oauth", () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let service: OauthService;
  let userId: string;
  let otherUserId: string;

  const page = (limit = 50) => service.listLinks(userId, { limit });

  async function credential(overrides: {
    user?: string;
    kind?: string;
    provider?: string | null;
    subject?: string | null;
    revoked?: boolean;
    createdAt?: string;
  }) {
    await pool.query(
      `INSERT INTO user_credentials (user_id, kind, provider, external_subject, credential_id, revoked_at, created_at)
       VALUES ($1, $2, $3, $4, NULL, $5, COALESCE($6::timestamptz, now()))`,
      [
        overrides.user ?? userId,
        overrides.kind ?? "oauth",
        overrides.provider === undefined ? "google" : overrides.provider,
        overrides.subject === undefined ? randomUUID() : overrides.subject,
        overrides.revoked === true ? new Date() : null,
        overrides.createdAt ?? null,
      ],
    );
  }

  beforeAll(async () => {
    applyFakeApiEnv();
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    // `migrateUp` takes a Client; a pooled connection is one.
    const migrationClient = await pool.connect();
    try {
      await migrateUp(migrationClient);
    } finally {
      migrationClient.release();
    }
    // The two collaborators this method never touches.
    service = new OauthService(pool, {} as never, {} as never);
  }, 300_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE user_credentials, users CASCADE");
    userId = randomUUID();
    otherUserId = randomUUID();
    for (const id of [userId, otherUserId]) {
      await pool.query(`INSERT INTO users (id, email, status) VALUES ($1, $2, 'active')`, [id, `${id}@nominara.test`]);
    }
  });

  it("lists a linked provider", async () => {
    await credential({ provider: "google" });

    const result = await page();
    expect(result.items.map((i) => i.provider)).toEqual(["google"]);
  });

  it("⚠ never lists a REVOKED link", async () => {
    // `unlink` revokes by setting `revoked_at` rather than deleting, so every
    // provider the caller has ever connected sits in this table. Reading it
    // unfiltered would offer "Disconnect" for an account they already
    // disconnected, and `unlink` would answer 403.
    await credential({ provider: "github", revoked: true });

    expect((await page()).items).toEqual([]);
  });

  it("⚠ never lists a PASSKEY as a connected account", async () => {
    await credential({ kind: "passkey", provider: null, subject: null });

    expect((await page()).items).toEqual([]);
  });

  it("⚠ never lists a SAML or OIDC binding", async () => {
    // Those are the organisation's enterprise sign-in, not a personal
    // connected account. Listing them here would offer an individual a
    // Disconnect for their company's SSO.
    await credential({ kind: "saml", provider: "google" });
    await credential({ kind: "oidc", provider: "microsoft" });

    expect((await page()).items).toEqual([]);
  });

  it("⚠ never lists ANOTHER person's link", async () => {
    // A credential belongs to a person. This is the actor-self-scoped class,
    // and the only thing scoping it is the `user_id` predicate.
    await credential({ user: otherUserId, provider: "github" });

    expect((await page()).items).toEqual([]);
  });

  it("⚠ publishes NO provider subject, and nothing else the contract omits", async () => {
    // `user_credentials.external_subject` is the provider's own account
    // identifier — a cross-service correlator this product has no reason to
    // hand back to a browser. The schema is `.strict()`, so a column added to
    // the SELECT fails this rather than shipping quietly.
    await credential({ provider: "google", subject: "google-subject-12345" });

    const [item] = (await page()).items;
    expect(oauthLinkItemSchema.safeParse(item).success).toBe(true);
    expect(JSON.stringify(item)).not.toContain("google-subject-12345");
    expect(Object.keys(item!).sort()).toEqual(["created_at", "last_used_at", "provider"]);
  });

  it("⚠ lists two accounts on the SAME provider, which the schema permits", async () => {
    // `ux_credentials_oauth` is unique on (provider, external_subject), NOT on
    // (user_id, provider) — so one person can link two different Google
    // accounts, and the set is bounded by nothing. That is why this route is
    // cursor-paginated rather than treated as a three-row enum.
    await credential({ provider: "google", subject: "one" });
    await credential({ provider: "google", subject: "two" });

    expect((await page()).items.map((i) => i.provider)).toEqual(["google", "google"]);
  });

  it("pages rather than returning everything at once", async () => {
    await credential({ provider: "google", createdAt: "2026-01-01T00:00:00Z" });
    await credential({ provider: "github", createdAt: "2026-02-01T00:00:00Z" });
    await credential({ provider: "microsoft", createdAt: "2026-03-01T00:00:00Z" });

    const first = await service.listLinks(userId, { limit: 2 });
    expect(first.items.map((i) => i.provider)).toEqual(["google", "github"]);
    expect(first.pagination.has_more).toBe(true);

    const second = await service.listLinks(userId, { limit: 2, cursor: first.pagination.cursor_next! });
    expect(second.items.map((i) => i.provider)).toEqual(["microsoft"]);
    expect(second.pagination.has_more).toBe(false);
  });

  it("says plainly that nothing is connected", async () => {
    expect((await page()).items).toEqual([]);
  });
});
