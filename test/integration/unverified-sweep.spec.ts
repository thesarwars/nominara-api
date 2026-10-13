import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { SweepBlindError, sweepStaleUnverifiedAccounts, UNVERIFIED_ACCOUNT_TTL_DAYS } from "../../src/workers/rollup/unverified-sweep.js";

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
  async function codeFor(userId: string, createdAt: Date): Promise<void> {
    await db.query("INSERT INTO email_otp_codes (user_id, code_hash, expires_at, created_at) VALUES ($1, 'h', $2, $3)", [
      userId,
      new Date(createdAt.getTime() + 10 * 60 * 1000),
      createdAt,
    ]);
  }
  async function exists(id: string): Promise<boolean> {
    return (await db.query("SELECT 1 FROM users WHERE id = $1", [id])).rows.length === 1;
  }

  it("STORY-173 · sweep — deletes a stale, untouched unverified account and its pending codes", async () => {
    const stale = await user({ ageDays: UNVERIFIED_ACCOUNT_TTL_DAYS + 1 });
    // The pending code is as old as the account: a code stamped with the wall clock would read as a recent
    // touch once the real date passes NOW - TTL, and the account would (correctly) be kept.
    await codeFor(stale, new Date(NOW.getTime() - (UNVERIFIED_ACCOUNT_TTL_DAYS + 1) * DAY));
    const result = await sweepStaleUnverifiedAccounts(db, NOW);
    expect(result).toEqual({ deleted: 1, skippedReferenced: 0, skippedLocked: 0 });
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
    expect(await sweepStaleUnverifiedAccounts(db, NOW)).toEqual({ deleted: 0, skippedReferenced: 0, skippedLocked: 0 });
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
    expect(await sweepStaleUnverifiedAccounts(db, NOW)).toEqual({ deleted: 0, skippedReferenced: 0, skippedLocked: 0 });
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
    expect(result).toEqual({ deleted: 1, skippedReferenced: 1, skippedLocked: 0 });
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
        // After the candidate was chosen, before the row is locked: the window in
        // which a session can still appear. (Once the sweep holds the users row,
        // an INSERT INTO sessions for it blocks on the foreign key until the
        // sweep's own transaction ends — the lock closes the race from there.)
        if (text.includes("FROM email_otp_codes") && text.includes("FOR UPDATE NOWAIT") && !injected) {
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

  it("STORY-173 · sweep — staleness is last ACTIVITY: a row with a code issued inside the TTL is a person mid sign-up and is kept", async () => {
    const midSignUp = await user({ ageDays: 30 });
    await codeFor(midSignUp, new Date(NOW.getTime() - 1 * DAY));
    const idle = await user({ ageDays: 30 });
    await codeFor(idle, new Date(NOW.getTime() - (UNVERIFIED_ACCOUNT_TTL_DAYS + 2) * DAY));
    const result = await sweepStaleUnverifiedAccounts(db, NOW);
    expect(result).toEqual({ deleted: 1, skippedReferenced: 0, skippedLocked: 0 });
    expect(await exists(midSignUp)).toBe(true);
    expect(await exists(idle)).toBe(false);
  });

  it("STORY-173 · sweep — a code issued after the sweep chose its candidates still protects the row (the DELETE re-checks)", async () => {
    const racing = await user({ ageDays: 30 });
    const realQuery = db.query.bind(db) as (...args: unknown[]) => Promise<unknown>;
    let injected = false;
    (db as unknown as { query: (...args: unknown[]) => Promise<unknown> }).query = async (...args: unknown[]) => {
      const text = typeof args[0] === "string" ? args[0] : "";
      if (text.startsWith("DELETE FROM users") && !injected) {
        injected = true;
        await realQuery("INSERT INTO email_otp_codes (user_id, code_hash, expires_at, created_at) VALUES ($1, 'h', $2, $3)", [
          racing,
          new Date(NOW.getTime() + 600_000),
          NOW,
        ]);
      }
      return realQuery(...args);
    };
    const result = await sweepStaleUnverifiedAccounts(db, NOW);
    expect(result.deleted).toBe(0);
    expect(await exists(racing)).toBe(true);
  });

  it("STORY-173 · sweep — each row is its own transaction, so no lock outlives its own row", async () => {
    await user({ ageDays: 30 });
    await user({ ageDays: 31 });
    await user({ ageDays: 32 });
    const statements: string[] = [];
    const realQuery = db.query.bind(db) as (...args: unknown[]) => Promise<unknown>;
    (db as unknown as { query: (...args: unknown[]) => Promise<unknown> }).query = async (...args: unknown[]) => {
      if (typeof args[0] === "string") statements.push(args[0].replace(/\s+/g, " ").trim());
      return realQuery(...args);
    };
    expect(await sweepStaleUnverifiedAccounts(db, NOW)).toEqual({ deleted: 3, skippedReferenced: 0, skippedLocked: 0 });
    expect(statements.filter((s) => s === "BEGIN")).toHaveLength(3);
    expect(statements.filter((s) => s === "COMMIT")).toHaveLength(3);
    // codes before the users row — the order the email-code verify takes them
    const firstCodes = statements.findIndex((s) => s.includes("FROM email_otp_codes") && s.includes("FOR UPDATE NOWAIT"));
    const firstUsers = statements.findIndex((s) => s.includes("FROM users") && s.includes("FOR UPDATE NOWAIT"));
    expect(firstCodes).toBeGreaterThan(-1);
    expect(firstUsers).toBeGreaterThan(firstCodes);
  });

  it("STORY-173 · sweep — a row whose lock somebody else holds is skipped without waiting, and the rest are still swept", async () => {
    const busyUsers = await user({ ageDays: 30 });
    const busyCodes = await user({ ageDays: 31 });
    await codeFor(busyCodes, new Date(NOW.getTime() - 20 * DAY));
    const free = await user({ ageDays: 32 });

    const holder = new Client({ connectionString: container.getConnectionUri() });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [busyUsers]);
      await holder.query("SELECT id FROM email_otp_codes WHERE user_id = $1 FOR UPDATE", [busyCodes]);
      const started = Date.now();
      const result = await sweepStaleUnverifiedAccounts(db, NOW);
      expect(Date.now() - started).toBeLessThan(5000);
      expect(result).toEqual({ deleted: 1, skippedReferenced: 0, skippedLocked: 2 });
      expect(await exists(busyUsers)).toBe(true);
      expect(await exists(busyCodes)).toBe(true);
      expect(await exists(free)).toBe(false);
    } finally {
      await holder.query("ROLLBACK").catch(() => {});
      await holder.end();
    }
  });

  it("STORY-173 · sweep — REFUSES on a connection that cannot see past row-level security, and deletes nothing (F-blind)", async () => {
    // workspace_members is FORCE RLS with policies for the runtime roles only and
    // cascades on delete: a blind role sees no memberships, would delete the
    // account that has one, and the cascade would silently remove the membership.
    const holder = await user({ ageDays: 30 });
    const wsId = await workspace();
    await db.query("INSERT INTO workspace_members (workspace_id, user_id, role, status) VALUES ($1, $2, 'owner', 'active')", [wsId, holder]);
    const plain = await user({ ageDays: 31 });

    await db.query("ALTER ROLE nominara_app PASSWORD 'blindsweep'");
    const blind = new Client({
      connectionString: `postgres://nominara_app:blindsweep@${container.getHost()}:${String(container.getMappedPort(5432))}/nominara_test`,
    });
    await blind.connect();
    try {
      await expect(sweepStaleUnverifiedAccounts(blind, NOW)).rejects.toBeInstanceOf(SweepBlindError);
      await expect(sweepStaleUnverifiedAccounts(blind, NOW)).rejects.toThrow(/neither bypasses row-level security nor is a superuser/);
    } finally {
      await blind.end();
    }
    expect(await exists(holder)).toBe(true);
    expect(await exists(plain)).toBe(true);
    expect((await db.query("SELECT 1 FROM workspace_members WHERE user_id = $1", [holder])).rows).toHaveLength(1);
  });

  it("STORY-173 · sweep — an error that is neither a held lock nor a foreign key is a fault, not a skip: it propagates and the row survives", async () => {
    const victim = await user({ ageDays: 30 });
    const realQuery = db.query.bind(db) as (...args: unknown[]) => Promise<unknown>;
    (db as unknown as { query: (...args: unknown[]) => Promise<unknown> }).query = async (...args: unknown[]) => {
      if (typeof args[0] === "string" && args[0].startsWith("DELETE FROM users")) throw new Error("disk on fire");
      return realQuery(...args);
    };
    await expect(sweepStaleUnverifiedAccounts(db, NOW)).rejects.toThrow("disk on fire");
    (db as unknown as { query: unknown }).query = realQuery;
    expect(await exists(victim)).toBe(true);
    // and the connection is left clean (the failed row's transaction was rolled back)
    expect(await sweepStaleUnverifiedAccounts(db, NOW)).toEqual({ deleted: 1, skippedReferenced: 0, skippedLocked: 0 });
  });
});
