import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Redis } from "ioredis";
import { Client, Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { REFRESH_TOKEN_GRACE_CACHE_DEADLINE_MS, hashRefreshToken, parseGraceSlot } from "../../src/lib/auth/refresh-token.js";
import { ValkeyCacheAdapter } from "../../src/lib/cache/valkey-cache.adapter.js";
import { cacheKeyNamespace } from "../../src/lib/cache/key-namespace.js";
import { refreshGraceSlotKey } from "../../src/lib/cache/valkey-keys.js";
import { SessionService } from "../../src/modules/identity/session.service.js";
import { MembershipService } from "../../src/modules/workspaces/membership.service.js";
import { MembershipCacheService } from "../../src/tenancy/membership-cache.js";
import { applyFakeApiEnv } from "../support/fake-env.js";
import { startValkey, type StartedValkey } from "../support/valkey-fixture.js";

// STORY-170 (Valkey revision) — the refresh-token grace slot against a REAL
// Valkey. session-refresh-grace-window.spec.ts owns the rules, on an
// in-memory cache whose clock it drives; this file owns what only a real cache
// can show, each of which is a claim about TIME on the CACHE'S clock:
//
//  1. the slot is GONE once the window passes — the TTL is honoured by the
//     server, the key is read directly, and a replay then revokes;
//  2. the window is anchored at the rotation's COMMIT, not at the request's
//     arrival: a rotation delayed past the window by a lock still lets a
//     replay that arrives just after its commit converge on the successor;
//  3. a cache that is down, or that accepted the call and went quiet, costs
//     the window and never the rotation;
//  4. a slot write the rotation ABANDONED at its deadline is not abandoned by
//     Valkey — it executes when the cache wakes, with a FULL TTL from then — and
//     the window is therefore also bounded on POSTGRES's clock, which no cache
//     stall can move.
//
// Real Postgres and real Valkey, and `SessionService` built directly on them:
// the delayed rotation needs a second connection holding a real row lock, and
// the expiry needs a server that really expires keys.
describe("STORY-170 · refresh-token grace slot on a real Valkey", () => {
  let postgres: StartedPostgreSqlContainer;
  let valkey: StartedValkey;
  let adapter: ValkeyCacheAdapter;
  let probe: Redis;
  let pauser: Redis;
  let pool: Pool;
  let db: Client;
  let sessions: SessionService;
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    [postgres, valkey] = await Promise.all([
      new PostgreSqlContainer("pgvector/pgvector:pg18")
        .withDatabase("nominara_test")
        .withUsername("nominara")
        .withPassword("nominara")
        .start(),
      startValkey(),
    ]);

    applyFakeApiEnv();
    process.env.DATABASE_URL = postgres.getConnectionUri();
    process.env.DATABASE_URL_POOLED = postgres.getConnectionUri();
    process.env.VALKEY_CACHE_URL = valkey.url;

    const migrator = new Client({ connectionString: postgres.getConnectionUri() });
    await migrator.connect();
    await migrateUp(migrator);
    await migrator.end();

    adapter = new ValkeyCacheAdapter(valkey.url);
    await adapter.connect();
    probe = new Redis(valkey.url);
    // CLIENT PAUSE also blocks the issuing connection's own writes, so the
    // pause is issued from a connection that never writes anything else.
    pauser = new Redis(valkey.url);
  }, 180_000);

  afterAll(async () => {
    probe.disconnect();
    pauser.disconnect();
    await adapter.onModuleDestroy();
    await Promise.all([postgres.stop(), valkey.stop()]);
    process.env = { ...originalEnv };
  });

  beforeEach(async () => {
    pool = new Pool({ connectionString: postgres.getConnectionUri() });
    db = new Client({ connectionString: postgres.getConnectionUri() });
    await db.connect();
    sessions = new SessionService(pool, new MembershipService(new MembershipCacheService()), adapter);
  });

  afterEach(async () => {
    delete process.env.REFRESH_TOKEN_GRACE_WINDOW_MS;
    await pool.end();
    await db.end();
  });

  async function createUser(): Promise<string> {
    const res = await db.query<{ id: string }>("INSERT INTO users (email) VALUES ($1) RETURNING id", [
      `grace-valkey-${String(Math.random()).slice(2)}@example.com`,
    ]);
    return res.rows[0]!.id;
  }

  function slotKey(sid: string): string {
    return refreshGraceSlotKey(cacheKeyNamespace(), sid);
  }

  async function revokedReason(sid: string): Promise<string | null> {
    const res = await db.query<{ revoked_reason: string | null }>("SELECT revoked_reason FROM sessions WHERE id = $1", [sid]);
    return res.rows[0]!.revoked_reason;
  }

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  async function waitUntil(condition: () => Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await condition())) {
      if (Date.now() > deadline) throw new Error(`timed out after ${String(timeoutMs)}ms waiting for ${what}`);
      await sleep(20);
    }
  }

  /** Backends currently blocked on a row lock whose statement matches `pattern`. */
  async function lockWaiters(pattern: string): Promise<number> {
    const res = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND query ILIKE $1 AND pid <> pg_backend_pid()`,
      [pattern],
    );
    return Number(res.rows[0]!.n);
  }

  it("FR-170-GRACE-V1 · the slot carries a TTL equal to the window and is GONE from Valkey once it passes — read directly — and a replay after that revokes", async () => {
    process.env.REFRESH_TOKEN_GRACE_WINDOW_MS = "600";
    const userId = await createUser();
    const initial = await sessions.createSession(userId);

    const rotated = await sessions.refresh(initial.refreshToken);

    const key = slotKey(initial.sid);
    const sealed = await probe.get(key);
    expect(sealed, "the slot exists right after the rotation").not.toBeNull();
    const ttlMs = await probe.pttl(key);
    expect(ttlMs, "a TTL was set (PTTL -1 would mean the slot never expires)").toBeGreaterThan(0);
    expect(ttlMs).toBeLessThanOrEqual(600);
    // Nothing usable in the clear: the predecessor's hash and a sealed successor.
    expect(sealed).not.toContain(rotated.refreshToken);
    expect(sealed).not.toContain(initial.refreshToken);
    expect(parseGraceSlot(sealed!)?.predecessorHash).toBe(hashRefreshToken(initial.refreshToken));

    // Inside the window, on the real cache: the identical successor.
    const inside = await sessions.refresh(initial.refreshToken);
    expect(inside.refreshToken).toBe(rotated.refreshToken);

    // The window passes on VALKEY'S clock: the key ceases to exist.
    await waitUntil(async () => (await probe.exists(key)) === 0, 5_000, "the slot to expire");
    expect(await probe.get(key)).toBeNull();

    await expect(sessions.refresh(initial.refreshToken)).rejects.toThrow("refresh token already used");
    expect(await revokedReason(initial.sid)).toBe("reuse_detected");
  });

  it(
    "FR-170-GRACE-V2 · a rotation DELAYED past the window by another connection's FOR UPDATE still hands a replay that arrives just after its commit the same successor — the window is anchored at commit",
    async () => {
      process.env.REFRESH_TOKEN_GRACE_WINDOW_MS = "1000";
      const userId = await createUser();
      const initial = await sessions.createSession(userId);

      // Another connection holds the session row: the rotation locks the token
      // row, then blocks here, for longer than the whole window.
      const blocker = new Client({ connectionString: postgres.getConnectionUri() });
      await blocker.connect();
      try {
        await blocker.query("BEGIN");
        await blocker.query("SELECT id FROM sessions WHERE id = $1 FOR UPDATE", [initial.sid]);
        const heldSince = Date.now();

        const arrivedAt = Date.now();
        const rotation = sessions.refresh(initial.refreshToken);
        await waitUntil(async () => (await lockWaiters("%FROM sessions WHERE id%FOR UPDATE%")) > 0, 10_000, "the rotation to block on the session row");

        // A racer that arrives while the rotation is still blocked: it queues
        // on the TOKEN row the rotation holds, and reads the slot the moment the
        // rotation's commit releases it.
        const racerDuringBlock = sessions.refresh(initial.refreshToken);
        await waitUntil(async () => (await lockWaiters("%FROM refresh_tokens WHERE token_hash%FOR UPDATE%")) > 0, 10_000, "the racer to queue on the token row");

        await sleep(Math.max(0, heldSince + 2_300 - Date.now()));
        await blocker.query("COMMIT");

        const rotated = await rotation;
        const committedAt = Date.now();
        expect(committedAt - arrivedAt, "the rotation really was delayed past the 1000ms window").toBeGreaterThan(1_000);
        expect(await probe.pttl(slotKey(initial.sid)), "the slot is alive at commit — the TTL started there").toBeGreaterThan(0);

        // Another tab, 50ms after the commit.
        await sleep(50);
        const lateReplay = await sessions.refresh(initial.refreshToken);

        expect(lateReplay.refreshToken).toBe(rotated.refreshToken);
        expect((await racerDuringBlock).refreshToken).toBe(rotated.refreshToken);
        expect(await revokedReason(initial.sid), "nobody was signed out").toBeNull();
      } finally {
        await blocker.query("ROLLBACK").catch(() => undefined);
        await blocker.end();
      }
    },
    30_000,
  );

  it("FR-170-GRACE-V3 · ten racers presenting the same token at once converge on ONE successor through the real cache, and the session survives", async () => {
    const userId = await createUser();
    const initial = await sessions.createSession(userId);

    const results = await Promise.all(Array.from({ length: 10 }, () => sessions.refresh(initial.refreshToken)));

    expect(new Set(results.map((r) => r.refreshToken)).size).toBe(1);
    expect(results[0]!.refreshToken).not.toBe(initial.refreshToken);
    expect(await revokedReason(initial.sid)).toBeNull();
  });

  it("FR-170-GRACE-V4 · Valkey DOWN: a refresh still rotates (no slot), and the replay revokes as the strict rule says", async () => {
    const dead = await startValkey();
    const deadAdapter = new ValkeyCacheAdapter(dead.url);
    await deadAdapter.connect();
    const strandedSessions = new SessionService(pool, new MembershipService(new MembershipCacheService()), deadAdapter);
    const userId = await createUser();
    const initial = await strandedSessions.createSession(userId);

    await dead.stop();

    const rotated = await strandedSessions.refresh(initial.refreshToken);
    expect(rotated.refreshToken).not.toBe(initial.refreshToken);
    expect(await probe.exists(slotKey(initial.sid)), "no slot could have been written").toBe(0);

    await expect(strandedSessions.refresh(initial.refreshToken)).rejects.toThrow("refresh token already used");
    expect(await revokedReason(initial.sid)).toBe("reuse_detected");

    await deadAdapter.onModuleDestroy().catch(() => undefined);
  }, 60_000);

  it(
    "FR-170-GRACE-V5 · Valkey CONNECTED BUT UNRESPONSIVE (CLIENT PAUSE): the rotation is bounded by the deadline, not by the cache, and the replay revokes",
    async () => {
      const userId = await createUser();
      const initial = await sessions.createSession(userId);

      const pauseMs = 3_000;
      await probe.call("CLIENT", "PAUSE", String(pauseMs), "ALL");
      const pausedAt = Date.now();
      try {
        const startedAt = performance.now();
        const rotated = await sessions.refresh(initial.refreshToken);
        const rotationMs = performance.now() - startedAt;

        expect(rotated.refreshToken).not.toBe(initial.refreshToken);
        expect(rotationMs).toBeGreaterThanOrEqual(REFRESH_TOKEN_GRACE_CACHE_DEADLINE_MS - 50);
        expect(rotationMs, "returned long before the pause ended: the wait was bounded").toBeLessThan(pauseMs);

        await expect(sessions.refresh(initial.refreshToken)).rejects.toThrow("refresh token already used");
        expect(await revokedReason(initial.sid)).toBe("reuse_detected");
      } finally {
        // Let the pause end so the abandoned commands drain before the next case.
        await sleep(Math.max(0, pausedAt + pauseMs + 200 - Date.now()));
      }
    },
    30_000,
  );

  it(
    "FR-170-GRACE-V6 · a slot write abandoned at the deadline that Valkey executes AFTER the window (CLIENT PAUSE WRITE) grants nothing — the replay revokes, on Postgres's clock",
    async () => {
      const windowMs = 600;
      process.env.REFRESH_TOKEN_GRACE_WINDOW_MS = String(windowMs);
      const userId = await createUser();
      const initial = await sessions.createSession(userId);
      const key = slotKey(initial.sid);

      // The pause outlasts the window AND the deadline together: the stalled
      // SET can only execute after the last moment a slot could honestly be
      // honoured for this rotation.
      const pauseMs = 2_500;
      await pauser.call("CLIENT", "PAUSE", String(pauseMs), "WRITE");
      const pausedAt = Date.now();
      try {
        const rotated = await sessions.refresh(initial.refreshToken);
        const committedAt = Date.now();
        expect(rotated.refreshToken).not.toBe(initial.refreshToken);
        expect(await probe.exists(key), "the write missed its deadline: no slot is visible at commit").toBe(0);

        // The abandoned SET is still queued inside Valkey. It lands when the pause ends.
        await waitUntil(async () => (await probe.exists(key)) === 1, pauseMs + 3_000, "the stalled SET to execute");
        const landedMs = Date.now() - committedAt;
        expect(
          landedMs,
          "precondition: the slot landed after window + deadline — a slot that lands inside the bound proves nothing",
        ).toBeGreaterThan(windowMs + REFRESH_TOKEN_GRACE_CACHE_DEADLINE_MS);
        expect(await probe.pttl(key), "precondition: it landed with a full, live TTL from then").toBeGreaterThan(0);

        // The consumed token is presented while that late slot is alive. The
        // cache would honour it; Postgres's own record of WHEN the rotation
        // happened must not.
        //
        // ⚠ THROUGH ANOTHER INSTANCE, AND THAT IS LOAD-BEARING. The instance
        // that rotated has had its circuit breaker opened by the missed
        // deadline, so it would refuse this replay without ever reading the
        // slot — and this test would pass with the hard bound deleted
        // (mutation-tested). A different process's breaker never tripped: it
        // reads the late slot, and only the database's clock stands between it
        // and the live successor.
        const otherInstance = new SessionService(pool, new MembershipService(new MembershipCacheService()), adapter);
        await expect(otherInstance.refresh(initial.refreshToken)).rejects.toThrow("refresh token already used");
        expect(await revokedReason(initial.sid)).toBe("reuse_detected");
      } finally {
        await sleep(Math.max(0, pausedAt + pauseMs + 200 - Date.now()));
      }
    },
    30_000,
  );
});
