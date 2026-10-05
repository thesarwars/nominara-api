import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { sweepStaleUnverifiedAccounts, UNVERIFIED_ACCOUNT_TTL_DAYS } from "../../src/workers/rollup/unverified-sweep.js";

// STORY-173 (owner decision "claim it + clean up") — an anonymous email-code
// request creates an `unverified` account; this sweep removes the ones nobody
// came back for, and ONLY those: no proof, no credential (revoked included), no
// session, no membership, older than the TTL.
describe("STORY-173 · stale unverified accounts are swept", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  const NOW = new Date("2026-10-20T12:00:00Z");
  const DAY = 24 * 60 * 60 * 1000;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();
  }, 180_000);
  afterAll(async () => {
    await container.stop();
  });
  beforeEach(async () => {
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await db.query("DROP SCHEMA IF EXISTS app CASCADE");
    await db.query("DROP SCHEMA IF EXISTS _migrations CASCADE");
    await db.query("DROP SCHEMA public CASCADE");
    await db.query("CREATE SCHEMA public");
    await migrateUp(db);
  });
  afterEach(async () => {
    await db.end();
  });

  async function user(options: { ageDays: number; status?: string; verified?: boolean }): Promise<string> {
    const result = await db.query<{ id: string }>(
      "INSERT INTO users (email, status, email_verified_at, created_at) VALUES ($1, $2, $3, $4) RETURNING id",
      [
        `s-${randomUUID()}@corp.example`,
        options.status ?? "unverified",
        options.verified ? NOW : null,
        new Date(NOW.getTime() - options.ageDays * DAY),
      ],
    );
    return result.rows[0]!.id;
  }
  async function workspace(): Promise<string> {
    const plan = await db.query<{ key: string }>("SELECT key FROM plans LIMIT 1");
    const result = await db.query<{ id: string }>(
      "INSERT INTO workspaces (name, slug, plan_key) VALUES ('W', $1, $2) RETURNING id",
      [`w-${randomUUID()}`, plan.rows[0]!.key],
    );
    return result.rows[0]!.id;
  }
  async function exists(id: string): Promise<boolean> {
    return (await db.query("SELECT 1 FROM users WHERE id = $1", [id])).rows.length === 1;
  }

  it("STORY-173 · sweep — deletes a stale, untouched unverified account and its pending codes", async () => {
    const stale = await user({ ageDays: UNVERIFIED_ACCOUNT_TTL_DAYS + 1 });
    await db.query("INSERT INTO email_otp_codes (user_id, code_hash, expires_at) VALUES ($1, 'h', now())", [stale]);
    const result = await sweepStaleUnverifiedAccounts(db, NOW);
    expect(result).toEqual({ deleted: 1, skipped: 0 });
    expect(await exists(stale)).toBe(false);
    expect((await db.query("SELECT 1 FROM email_otp_codes WHERE user_id = $1", [stale])).rows).toHaveLength(0);
  });

  it("STORY-173 · sweep — the TTL boundary: exactly the TTL old stays, one second older goes", async () => {
    const atBoundary = await user({ ageDays: UNVERIFIED_ACCOUNT_TTL_DAYS });
    const past = await db.query<{ id: string }>(
      "INSERT INTO users (email, status, created_at) VALUES ($1, 'unverified', $2) RETURNING id",
      [`s-${randomUUID()}@corp.example`, new Date(NOW.getTime() - UNVERIFIED_ACCOUNT_TTL_DAYS * DAY - 1000)],
    );
    await sweepStaleUnverifiedAccounts(db, NOW);
    expect(await exists(atBoundary)).toBe(true);
    expect(await exists(past.rows[0]!.id)).toBe(false);
  });

  it("STORY-173 · sweep — keeps a fresh account, a proved one, and an active one, however old", async () => {
    const fresh = await user({ ageDays: 1 });
    const proved = await user({ ageDays: 30, status: "unverified", verified: true });
    const active = await user({ ageDays: 30, status: "active", verified: false });
    const suspended = await user({ ageDays: 30, status: "suspended" });
    expect(await sweepStaleUnverifiedAccounts(db, NOW)).toEqual({ deleted: 0, skipped: 0 });
    for (const id of [fresh, proved, active, suspended]) expect(await exists(id)).toBe(true);
  });

  it("STORY-173 · sweep — keeps an account with a credential (even a revoked one), a session, or a membership", async () => {
    const withCredential = await user({ ageDays: 30 });
    await db.query(
      "INSERT INTO user_credentials (user_id, kind, provider, external_subject, revoked_at, revoked_reason) VALUES ($1, 'oauth', 'google', 'sub-x', now(), 'address_proved')",
      [withCredential],
    );
    const withSession = await user({ ageDays: 30 });
    await db.query("INSERT INTO sessions (user_id) VALUES ($1)", [withSession]);
    const withMembership = await user({ ageDays: 30 });
    await db.query("INSERT INTO workspace_members (workspace_id, user_id, role, status) VALUES ($1, $2, 'owner', 'active')", [
      await workspace(),
      withMembership,
    ]);
    expect(await sweepStaleUnverifiedAccounts(db, NOW)).toEqual({ deleted: 0, skipped: 0 });
    expect(await exists(withCredential)).toBe(true);
    expect(await exists(withSession)).toBe(true);
    expect(await exists(withMembership)).toBe(true);
  });

  it("STORY-173 · sweep — a row another table still references is skipped, never forced, and the rest are still swept", async () => {
    const referenced = await user({ ageDays: 30 });
    const inviter = await user({ ageDays: 0, status: "active", verified: true });
    const orphan = await user({ ageDays: 30 });
    // A foreign key with no cascade points at `referenced` (accepted_user_id).
    const wsId = await workspace();
    await db.query(
      `INSERT INTO workspace_invitations (workspace_id, email, role, token_hash, invited_by, accepted_user_id, expires_at)
       VALUES ($1, 'a@corp.example', 'viewer', $2, $3, $4, now() + interval '1 day')`,
      [wsId, Buffer.from(randomUUID()), inviter, referenced],
    );
    const result = await sweepStaleUnverifiedAccounts(db, NOW);
    expect(result).toEqual({ deleted: 1, skipped: 1 });
    expect(await exists(referenced)).toBe(true);
    expect(await exists(orphan)).toBe(false);
  });

  it("STORY-173 · sweep — a candidate that gained a session after it was selected is not deleted", async () => {
    // The DELETE re-checks every condition, so a row that stops qualifying
    // between the SELECT and the DELETE survives. Simulated by giving the row a
    // session from a second connection while the sweep's own transaction runs.
    const racing = await user({ ageDays: 30 });
    const other = new Client({ connectionString: container.getConnectionUri() });
    await other.connect();
    try {
      const realQuery = db.query.bind(db) as (...args: unknown[]) => Promise<unknown>;
      let injected = false;
      (db as unknown as { query: (...args: unknown[]) => Promise<unknown> }).query = async (...args: unknown[]) => {
        const text = typeof args[0] === "string" ? args[0] : "";
        if (text.startsWith("DELETE FROM users") && !injected) {
          injected = true;
          await other.query("INSERT INTO sessions (user_id) VALUES ($1)", [racing]);
        }
        return realQuery(...args);
      };
      const result = await sweepStaleUnverifiedAccounts(db, NOW);
      expect(result.deleted).toBe(0);
      expect(await exists(racing)).toBe(true);
    } finally {
      await other.end();
    }
  });
});
