import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { oauthLinkItemSchema } from "../../contracts/identity/oauth-link-response.schema.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { IdentityService } from "../../src/modules/identity/identity.service.js";
import { OauthService } from "../../src/modules/identity/oauth.service.js";
import { applyFakeApiEnv } from "../support/fake-env.js";

// STORY-173 — unlinking needs a fresh step-up; these service-level scenarios are
// about the last-credential rule, not step-up (identity-oauth-proves-email.spec.ts).
const FRESH_STEP_UP = { lastStrongAuthAt: new Date(), lastStrongAuthMethod: "email_otp" } as const;

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

  it("⚠ excludes an oauth row with no provider, which no constraint forbids", () => {
    // The guard exists and had no test: nothing in the schema stops a
    // `kind='oauth'` row with a NULL provider, and `responseSchema` is used
    // only for OpenAPI generation — there is no runtime response validation —
    // so `{"provider": null}` would reach the wire against a strict enum.
    return (async () => {
      await credential({ provider: null, subject: "no-provider" });
      expect((await page()).items).toEqual([]);
    })();
  });

  it("⚠ the CURSOR publishes the row id, which the item deliberately omits", () => {
    // The cursor is unsigned base64url of the sort tuple, so `id` is readable
    // by anyone holding one. That is a deliberate consequence of cursor
    // pagination and not a leak of `external_subject` — asserted here so it
    // stays a decision rather than a surprise. The assertion that the ITEM
    // omits it lives above; this one covers the half that inspection misses.
    return (async () => {
      await credential({ provider: "google", subject: "one" });
      await credential({ provider: "github", subject: "two" });

      const first = await service.listLinks(userId, { limit: 1 });
      const decoded = Buffer.from(first.pagination.cursor_next!, "base64url").toString("utf8");

      expect(decoded).not.toContain("one");
      expect(decoded).not.toContain("two");
      expect(decoded).toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/); // the row id, by design
    })();
  });
});

// ⚠ THE LOCKOUT HAZARD THIS SCREEN NEWLY CREATES, and it had no test.
//
// `/settings/security` is the first surface to put "remove a passkey" and
// "disconnect an account" side by side. The existing race test in
// identity-passkey-webauthn.spec.ts is passkey-versus-passkey; nothing raced
// `IdentityService.revokePasskey` against `OauthService.unlink`. Both count
// the caller's whole active credential set under `FOR UPDATE` before deciding,
// so the second transaction must block and re-evaluate — but a future
// narrowing of either lock to the target row would ship green without this.
describe("STORY-096C · a person cannot be locked out by removing their last two credentials at once", () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let oauth: OauthService;
  let identity: IdentityService;

  beforeAll(async () => {
    applyFakeApiEnv();
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    const client = await pool.connect();
    try {
      await migrateUp(client);
    } finally {
      client.release();
    }
    oauth = new OauthService(pool, {} as never, {} as never);
    identity = new IdentityService(pool, {} as never);
  }, 300_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  it("⚠ the rule counts BOTH KINDS — an oauth link is removable while a passkey remains", async () => {
    // The mirror of the lockout assertion, and the one that catches
    // OVER-refusal. Narrowing `unlink`'s lock/count to `kind = 'oauth'` still
    // passes the concurrent test — it refuses, which is what that test wants —
    // but it refuses a person who has a perfectly good passkey to fall back
    // on. The last-credential rule is about the whole credential set, not
    // about the set of one kind.
    const id = randomUUID();
    await pool.query(`INSERT INTO users (id, email, status) VALUES ($1, $2, 'active')`, [id, `${id}@nominara.test`]);
    await pool.query(
      `INSERT INTO user_credentials (user_id, kind, credential_id, public_key, sign_count)
       VALUES ($1, 'passkey', $2, '\\x00'::bytea, 0)`,
      [id, Buffer.from(randomUUID())],
    );
    await pool.query(
      `INSERT INTO user_credentials (user_id, kind, provider, external_subject) VALUES ($1, 'oauth', 'google', $2)`,
      [id, randomUUID()],
    );

    await expect(oauth.unlink(id, "google", FRESH_STEP_UP)).resolves.toBeUndefined();

    const left = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM user_credentials WHERE user_id = $1 AND revoked_at IS NULL`,
      [id],
    );
    expect(Number(left.rows[0]!.n)).toBe(1);
  });

  it("⚠ and refuses once that passkey is the only thing left", async () => {
    const id = randomUUID();
    await pool.query(`INSERT INTO users (id, email, status) VALUES ($1, $2, 'active')`, [id, `${id}@nominara.test`]);
    await pool.query(
      `INSERT INTO user_credentials (user_id, kind, provider, external_subject) VALUES ($1, 'oauth', 'github', $2)`,
      [id, randomUUID()],
    );

    await expect(oauth.unlink(id, "github", FRESH_STEP_UP)).rejects.toThrow(/last remaining credential/i);
  });

  it("⚠ one of the two concurrent removals is refused, every time", async () => {
    const ROUNDS = 8;
    const outcomes: string[] = [];

    for (let round = 0; round < ROUNDS; round += 1) {
      const id = randomUUID();
      await pool.query(`INSERT INTO users (id, email, status) VALUES ($1, $2, 'active')`, [id, `${id}@nominara.test`]);
      const passkey = await pool.query<{ id: string }>(
        `INSERT INTO user_credentials (user_id, kind, credential_id, public_key, sign_count)
         VALUES ($1, 'passkey', $2, '\\x00'::bytea, 0) RETURNING id`,
        [id, Buffer.from(randomUUID())],
      );
      await pool.query(
        `INSERT INTO user_credentials (user_id, kind, provider, external_subject) VALUES ($1, 'oauth', 'google', $2)`,
        [id, randomUUID()],
      );

      // Fired together: one removes the last passkey, the other the last link.
      const [a, b] = await Promise.allSettled([
        identity.revokePasskey(id, passkey.rows[0]!.id, FRESH_STEP_UP),
        oauth.unlink(id, "google", FRESH_STEP_UP),
      ]);

      const left = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM user_credentials WHERE user_id = $1 AND revoked_at IS NULL`,
        [id],
      );
      outcomes.push(`${a.status}/${b.status}:${left.rows[0]!.n}`);

      // ⚠ NEVER ZERO. That is the whole assertion — a person with two ways in
      // who removes both at once must keep one, not lose both to a race.
      expect(Number(left.rows[0]!.n)).toBeGreaterThanOrEqual(1);
      // And exactly one of the two was refused, rather than both succeeding.
      expect([a.status, b.status].filter((s) => s === "rejected")).toHaveLength(1);
    }

    expect(outcomes).toHaveLength(ROUNDS);
  }, 120_000);
});
