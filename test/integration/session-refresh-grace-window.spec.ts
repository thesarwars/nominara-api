import { Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionService } from "../../src/modules/identity/session.service.js";
import { MembershipService } from "../../src/modules/workspaces/membership.service.js";
import {
  REFRESH_TOKEN_GRACE_CACHE_COOLOFF_MS,
  REFRESH_TOKEN_GRACE_CACHE_DEADLINE_MS,
  REFRESH_TOKEN_GRACE_WINDOW_DEFAULT_MS,
  generateRefreshToken,
  hashRefreshToken,
  parseGraceSlot,
  serializeGraceSlot,
} from "../../src/lib/auth/refresh-token.js";
import { InMemoryCacheAdapter } from "../../src/lib/cache/in-memory-cache.adapter.js";
import { cacheKeyNamespace } from "../../src/lib/cache/key-namespace.js";
import { refreshGraceSlotKey } from "../../src/lib/cache/valkey-keys.js";
import {
  ACCESS_COOKIE_NAME,
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  REFRESH_COOKIE_NAME,
} from "../../src/lib/auth/cookies.js";
import { importEd25519PublicKeyFromDer, verifyAccessToken } from "../../src/lib/auth/access-token.js";
import { apiUrl } from "../support/api-url.js";
import { dataOf } from "../support/envelope.js";
import { HARNESS_PUBLIC_KEY_DER, useApiHarness } from "../support/api-harness.js";
import { FAULT_ERROR_SECRET, FaultInjectingCache, type CacheOperation } from "../support/fault-injecting-cache.js";
import { MembershipCacheService } from "../../src/tenancy/membership-cache.js";
import * as metrics from "../../src/lib/telemetry/metrics.js";

// STORY-170 (grace-window revision) — security-and-tenancy.md §5 "Session
// model": presenting a consumed refresh token normally revokes the whole
// family. This moves the client's own former replay tolerance
// (CONSUMED_TOKEN_REPLAY_GRACE_MS, 1.5s, in refresh-single-flight.ts) INTO
// the API, audited, and bounded — a request restored across tabs or
// instances that arrives after a rotation already completed, presenting the
// just-consumed token, now gets the SAME successor back instead of being
// signed out, but ONLY for the token consumed by the session's OWN
// immediately-preceding rotation, and ONLY for a short window.
//
// THE SLOT LIVES IN THE CACHE, NOT POSTGRES, with a TTL equal to the window
// (session.service.ts's header says why). So the window's clock here is the
// CACHE'S clock: this spec hands the real ApiModule an InMemoryCacheAdapter
// whose clock it owns, and "the window has closed" means advancing that
// clock — the `now` argument of refresh() is only the JWT's iat and no longer
// has any say. The real Valkey (a TTL that genuinely expires, and a rotation
// delayed past the window) is session-refresh-grace-valkey.spec.ts.
//
// Real Postgres through the real, deployed ApiModule (useApiHarness) — same
// reasoning as session-refresh-keeps-workspace.spec.ts's own header: the
// workspace re-verification a grace hit ALSO runs opens its own
// withTenantContext transactions via MembershipService, which cannot be
// trusted against a mocked pg client.
describe("STORY-170 · refresh-token reuse grace window", () => {
  let clockMs = Date.now();
  let cache: FaultInjectingCache;
  const harness = useApiHarness({
    cache: () => {
      clockMs = Date.now();
      cache = new FaultInjectingCache(new InMemoryCacheAdapter(() => clockMs));
      return cache;
    },
  });
  let pool: Pool;

  beforeEach(() => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
  });

  afterEach(async () => {
    delete process.env.REFRESH_TOKEN_GRACE_WINDOW_MS;
    vi.restoreAllMocks();
    await pool.end();
  });

  function slotKey(sid: string): string {
    return refreshGraceSlotKey(cacheKeyNamespace(), sid);
  }

  /** The cache's clock moves past the default window: the slot's TTL has run out. */
  function closeWindow(): void {
    clockMs += REFRESH_TOKEN_GRACE_WINDOW_DEFAULT_MS + 1;
  }

  interface CookieTriple {
    readonly access: string;
    readonly refresh: string;
    readonly csrf: string;
  }

  function cookiesByName(res: { cookies: Array<{ name: string; value: string }> }): Map<string, string> {
    return new Map(res.cookies.map((c) => [c.name, c.value]));
  }

  async function createUser(): Promise<string> {
    const userId = randomUUID();
    await harness.db().query(
      `INSERT INTO users (id, email, email_verified_at, status, created_at, updated_at)
       VALUES ($1, $2, now(), 'active', now(), now())`,
      [userId, `${userId}@example.test`],
    );
    return userId;
  }

  async function addMember(workspaceId: string, userId: string, role: string): Promise<void> {
    await harness
      .db()
      .query(`INSERT INTO workspace_members (id, workspace_id, user_id, role, status) VALUES ($1,$2,$3,$4,'active')`, [
        randomUUID(),
        workspaceId,
        userId,
        role,
      ]);
  }

  async function decode(token: string) {
    const publicKey = importEd25519PublicKeyFromDer(HARNESS_PUBLIC_KEY_DER);
    return verifyAccessToken(token, () => publicKey);
  }

  async function createWorkspace(owner: CookieTriple): Promise<string> {
    const res = await harness.app().inject({
      method: "POST",
      url: apiUrl("/workspaces"),
      cookies: { [ACCESS_COOKIE_NAME]: owner.access, [CSRF_COOKIE_NAME]: owner.csrf },
      headers: { [CSRF_HEADER_NAME]: owner.csrf },
      payload: { name: `Workspace ${randomUUID()}` },
    });
    expect(res.statusCode, res.body).toBe(201);
    return dataOf<{ id: string }>(res).id;
  }

  interface SessionState {
    revoked_at: Date | null;
    revoked_reason: string | null;
  }

  async function sessionRow(sid: string): Promise<SessionState> {
    const res = await pool.query<SessionState>(`SELECT revoked_at, revoked_reason FROM sessions WHERE id = $1`, [sid]);
    return res.rows[0]!;
  }

  it("FR-170-GRACE-1 · a second refresh with the same, just-consumed token INSIDE the window gets the identical successor — the session stays alive", async () => {
    const userId = await createUser();
    const sessions = harness.app().get(SessionService);
    const initial = await sessions.createSession(userId);

    const rotated = await sessions.refresh(initial.refreshToken);
    const replay = await sessions.refresh(initial.refreshToken);

    expect(replay.sid).toBe(initial.sid);
    expect(replay.refreshToken).toBe(rotated.refreshToken);
    // The access token is minted fresh each time — only the raw refresh
    // token value is required to be identical (design note: "a fresh access
    // token is fine").
    expect(replay.accessToken).not.toBe(rotated.accessToken);

    const row = await sessionRow(initial.sid);
    expect(row.revoked_at).toBeNull();
    expect(row.revoked_reason).toBeNull();
  });

  it("FR-170-GRACE-1b · a THIRD racer, also inside the window, gets the SAME successor as the second — every racer converges, not just a pair", async () => {
    const userId = await createUser();
    const sessions = harness.app().get(SessionService);
    const initial = await sessions.createSession(userId);

    const rotated = await sessions.refresh(initial.refreshToken);
    const secondReplay = await sessions.refresh(initial.refreshToken);
    const thirdReplay = await sessions.refresh(initial.refreshToken);

    expect(secondReplay.refreshToken).toBe(rotated.refreshToken);
    expect(thirdReplay.refreshToken).toBe(rotated.refreshToken);
  });

  it("FR-170-GRACE-2 · a grace-window hit is audited as session.refresh_grace_reuse, naming the session id and never a raw token", async () => {
    const userId = await createUser();
    const sessions = harness.app().get(SessionService);
    const initial = await sessions.createSession(userId);
    const counterSpy = vi.spyOn(metrics, "incrementCounter");
    const warnSpy = vi.spyOn(Logger.prototype, "warn");

    const rotated = await sessions.refresh(initial.refreshToken);
    const replay = await sessions.refresh(initial.refreshToken);

    expect(counterSpy).toHaveBeenCalledWith(
      "nominara_identity_session_refresh_grace_reuse_total",
      expect.objectContaining({ session_id: initial.sid }),
    );
    // Never the reuse_detected event for a grace-window hit.
    expect(counterSpy).not.toHaveBeenCalledWith("nominara_identity_session_reuse_detected_total", expect.anything());

    // The log line carries the literal event name, so an alert or a grep on
    // `session.refresh_grace_reuse` finds it — not only the metric.
    const graceWarnCall = warnSpy.mock.calls.find((call) => String(call[0]).includes("session.refresh_grace_reuse"));
    expect(graceWarnCall, "expected a warn log line naming session.refresh_grace_reuse").toBeDefined();
    expect(String(graceWarnCall![0])).toContain(initial.sid);

    // NFR-SEC-11 — no raw token value anywhere in what was logged/metered,
    // across BOTH the presented (consumed) token and the returned successor.
    const loggedText = warnSpy.mock.calls.map((call) => String(call[0])).join("\n");
    const meteredText = counterSpy.mock.calls.map((call) => JSON.stringify(call)).join("\n");
    expect(loggedText).not.toContain(initial.refreshToken);
    expect(loggedText).not.toContain(rotated.refreshToken);
    expect(loggedText).not.toContain(replay.refreshToken);
    expect(meteredText).not.toContain(initial.refreshToken);
    expect(meteredText).not.toContain(rotated.refreshToken);
  });

  it("FR-170-GRACE-3 · the SAME consumed token presented OUTSIDE the window still revokes the family and raises session.reuse_detected", async () => {
    const userId = await createUser();
    const sessions = harness.app().get(SessionService);
    const initial = await sessions.createSession(userId);
    const counterSpy = vi.spyOn(metrics, "incrementCounter");

    await sessions.refresh(initial.refreshToken);
    closeWindow();

    await expect(sessions.refresh(initial.refreshToken)).rejects.toThrow("refresh token already used");

    expect(counterSpy).toHaveBeenCalledWith(
      "nominara_identity_session_reuse_detected_total",
      expect.objectContaining({ session_id: initial.sid }),
    );
    const row = await sessionRow(initial.sid);
    expect(row.revoked_at).not.toBeNull();
    expect(row.revoked_reason).toBe("reuse_detected");
  });

  it("FR-170-GRACE-3b · a grace hit does NOT re-date the slot — the window closes when the rotation's window closes, however many racers arrive inside it", async () => {
    const userId = await createUser();
    const sessions = harness.app().get(SessionService);
    const initial = await sessions.createSession(userId);

    await sessions.refresh(initial.refreshToken);
    clockMs += REFRESH_TOKEN_GRACE_WINDOW_DEFAULT_MS - 500;
    await expect(sessions.refresh(initial.refreshToken)).resolves.toBeDefined();

    // 600ms later the ROTATION's window is over (2100ms after it), though it
    // is only 600ms after the last hit. A hit that re-wrote the slot would
    // still be honoured here.
    clockMs += 600;
    await expect(sessions.refresh(initial.refreshToken)).rejects.toThrow("refresh token already used");
  });

  it("FR-170-GRACE-4 · an older (two-back) token still revokes even though it is presented inside what is now a DIFFERENT rotation's grace window", async () => {
    const userId = await createUser();
    const sessions = harness.app().get(SessionService);
    const initial = await sessions.createSession(userId);

    // A -> B (consumes A, opens A's grace window).
    const afterFirst = await sessions.refresh(initial.refreshToken);
    // B -> C (consumes B, opens B's grace window — the ONE grace slot this
    // session has now describes B, not A).
    await sessions.refresh(afterFirst.refreshToken);

    // Replay A, comfortably inside the DEFAULT window's duration, but A is no
    // longer "the immediately preceding rotation"'s token (B is), so this
    // must still revoke.
    await expect(sessions.refresh(initial.refreshToken)).rejects.toThrow("refresh token already used");

    const row = await sessionRow(initial.sid);
    expect(row.revoked_at).not.toBeNull();
    expect(row.revoked_reason).toBe("reuse_detected");
  });

  it("FR-170-GRACE-5 · a reuse revocation removes the session's slot from the cache, so a dead family holds no sealed successor", async () => {
    const userId = await createUser();
    const sessions = harness.app().get(SessionService);
    const initial = await sessions.createSession(userId);
    const afterFirst = await sessions.refresh(initial.refreshToken);
    await sessions.refresh(afterFirst.refreshToken);
    expect(await cache.get(slotKey(initial.sid)), "the slot exists before the revocation").toBeDefined();

    // Two-back, inside the window: revokes.
    await expect(sessions.refresh(initial.refreshToken)).rejects.toThrow("refresh token already used");

    expect(await cache.get(slotKey(initial.sid))).toBeUndefined();
  });

  it("FR-170-GRACE-6 · the slot is replaced (never left describing the OLD predecessor) by the session's next rotation", async () => {
    const userId = await createUser();
    const sessions = harness.app().get(SessionService);
    const initial = await sessions.createSession(userId);

    const afterFirst = await sessions.refresh(initial.refreshToken);
    const firstSlot = parseGraceSlot((await cache.get(slotKey(initial.sid)))!);
    expect(firstSlot?.predecessorHash).toBe(hashRefreshToken(initial.refreshToken));

    // A legitimate next rotation, using the CURRENT valid token — not a
    // replay of anything.
    await sessions.refresh(afterFirst.refreshToken);
    const secondSlot = parseGraceSlot((await cache.get(slotKey(initial.sid)))!);

    // The slot now names the token consumed by the SECOND rotation, not the
    // first — the old predecessor is no longer grace-eligible at all,
    // regardless of timing (FR-170-GRACE-4 proves the reuse consequence).
    expect(secondSlot?.predecessorHash).toBe(hashRefreshToken(afterFirst.refreshToken));
    expect(secondSlot?.successorCiphertext).not.toBe(firstSlot?.successorCiphertext);
  });

  it("FR-170-GRACE-7 · the workspace re-verification STORY-170 added still runs on a grace hit — a role downgraded between the rotation and the grace replay is reflected immediately, never the stale role", async () => {
    const ownerId = await createUser();
    const owner = harness.app().get(SessionService);
    const ownerTokens = await owner.createSession(ownerId);
    const workspaceId = await createWorkspace({
      access: ownerTokens.accessToken,
      refresh: ownerTokens.refreshToken,
      csrf: ownerTokens.csrfToken,
    });

    const memberId = await createUser();
    await addMember(workspaceId, memberId, "admin");
    const memberInitial = await owner.createSession(memberId);
    await owner.switchWorkspace(memberInitial.sid, memberId, workspaceId, "admin", null, 1);
    // switchWorkspace (service-level seam) does not touch the DB column the
    // real /workspaces/{id}/switch route does — set it directly, same
    // precedent as session-refresh-keeps-workspace.spec.ts's own FORCE-RLS
    // scenario.
    await pool.query(`UPDATE sessions SET active_workspace_id = $2 WHERE id = $1`, [memberInitial.sid, workspaceId]);

    const rotated = await owner.refresh(memberInitial.refreshToken);
    expect((await decode(rotated.accessToken)).role).toBe("admin");

    const membership = harness.app().get(MembershipService);
    await membership.updateRole(pool, workspaceId, memberId, "viewer");

    const graceHit = await owner.refresh(memberInitial.refreshToken);
    expect(graceHit.refreshToken).toBe(rotated.refreshToken);
    expect((await decode(graceHit.accessToken)).role).toBe("viewer");
  });

  it("real HTTP chain · two POST /auth/refresh calls presenting the same cookie, milliseconds apart, both return 200 with the identical refresh cookie", async () => {
    const userId = await createUser();
    const sessions = harness.app().get(SessionService);
    const initial = await sessions.createSession(userId);

    const first = await harness.app().inject({
      method: "POST",
      url: apiUrl("/auth/refresh"),
      cookies: { [REFRESH_COOKIE_NAME]: initial.refreshToken },
    });
    expect(first.statusCode).toBe(200);
    const firstRefresh = cookiesByName(first).get(REFRESH_COOKIE_NAME);

    const second = await harness.app().inject({
      method: "POST",
      url: apiUrl("/auth/refresh"),
      cookies: { [REFRESH_COOKIE_NAME]: initial.refreshToken },
    });
    expect(second.statusCode).toBe(200);
    expect(cookiesByName(second).get(REFRESH_COOKIE_NAME)).toBe(firstRefresh);

    const row = await sessionRow(initial.sid);
    expect(row.revoked_at).toBeNull();
  });

  it("FR-170-GRACE-8 · a logout INSIDE the window, then a replay of the consumed token, is refused — no successor and no access token are minted for a revoked session", async () => {
    const userId = await createUser();
    const sessions = harness.app().get(SessionService);
    const initial = await sessions.createSession(userId);
    const rotated = await sessions.refresh(initial.refreshToken);
    expect(await cache.get(slotKey(initial.sid)), "the slot is still live: only the revocation can refuse").toBeDefined();

    await sessions.logout(initial.sid);

    let leaked: unknown;
    await sessions
      .refresh(initial.refreshToken)
      .then((tokens) => {
        leaked = tokens;
      })
      .catch(() => undefined);
    expect(leaked, "a logged-out session must not be handed a successor or an access token").toBeUndefined();
    await expect(sessions.refresh(initial.refreshToken)).rejects.toThrow("refresh token already used");
    // The successor is dead as well: the family is revoked.
    await expect(sessions.refresh(rotated.refreshToken)).rejects.toThrow("session revoked");

    const row = await sessionRow(initial.sid);
    expect(row.revoked_reason, "the logout stays the recorded reason").toBe("logout");
  });

  it("FR-170-GRACE-9 · REFRESH_TOKEN_GRACE_WINDOW_MS=0 disables grace: no slot is written, and an IMMEDIATE replay revokes", async () => {
    process.env.REFRESH_TOKEN_GRACE_WINDOW_MS = "0";
    const userId = await createUser();
    const sessions = harness.app().get(SessionService);
    const initial = await sessions.createSession(userId);
    const counterSpy = vi.spyOn(metrics, "incrementCounter");

    await sessions.refresh(initial.refreshToken);
    expect(await cache.get(slotKey(initial.sid)), "0 must write no slot").toBeUndefined();

    await expect(sessions.refresh(initial.refreshToken)).rejects.toThrow("refresh token already used");
    expect(counterSpy).toHaveBeenCalledWith(
      "nominara_identity_session_reuse_detected_total",
      expect.objectContaining({ session_id: initial.sid }),
    );
    expect(counterSpy).not.toHaveBeenCalledWith("nominara_identity_session_refresh_grace_reuse_total", expect.anything());
    expect((await sessionRow(initial.sid)).revoked_reason).toBe("reuse_detected");
  });

  it("FR-170-GRACE-9b · a window of 0 ignores a slot the cache still holds from an earlier, larger setting", async () => {
    const userId = await createUser();
    const sessions = harness.app().get(SessionService);
    const initial = await sessions.createSession(userId);
    await sessions.refresh(initial.refreshToken);
    expect(await cache.get(slotKey(initial.sid))).toBeDefined();

    process.env.REFRESH_TOKEN_GRACE_WINDOW_MS = "0";

    await expect(sessions.refresh(initial.refreshToken)).rejects.toThrow("refresh token already used");
  });

  // Every condition of "the successor is live" gets its own case, and each
  // is built by breaking exactly ONE of them on an otherwise valid slot — the
  // shape of "some path rotated without rewriting the slot".
  it.each([
    {
      condition: "consumed",
      break: (successorHash: string, _other: string) =>
        `UPDATE refresh_tokens SET consumed_at = now() WHERE token_hash = '${successorHash}'`,
    },
    {
      condition: "expired",
      break: (successorHash: string, _other: string) =>
        `UPDATE refresh_tokens SET expires_at = now() - interval '1 second' WHERE token_hash = '${successorHash}'`,
    },
    {
      condition: "owned by another session",
      // One unconsumed token per session is a unique index, so the other
      // session's own active token is consumed first to make room.
      break: (successorHash: string, otherSid: string) =>
        `UPDATE refresh_tokens SET consumed_at = now() WHERE session_id = '${otherSid}' AND consumed_at IS NULL;
         UPDATE refresh_tokens SET session_id = '${otherSid}' WHERE token_hash = '${successorHash}'`,
    },
    {
      condition: "gone",
      break: (successorHash: string, _other: string) => `DELETE FROM refresh_tokens WHERE token_hash = '${successorHash}'`,
    },
  ])(
    "FR-170-GRACE-10 · a slot whose successor is $condition falls through to revocation — an already-dead successor is never handed out",
    async ({ break: breakSuccessor }) => {
      const userId = await createUser();
      const sessions = harness.app().get(SessionService);
      const initial = await sessions.createSession(userId);
      const other = await sessions.createSession(userId);
      const rotated = await sessions.refresh(initial.refreshToken);
      expect(await cache.get(slotKey(initial.sid)), "the slot itself is valid and live").toBeDefined();

      await pool.query(breakSuccessor(hashRefreshToken(rotated.refreshToken), other.sid));

      await expect(sessions.refresh(initial.refreshToken)).rejects.toThrow("refresh token already used");
      expect((await sessionRow(initial.sid)).revoked_reason).toBe("reuse_detected");
      expect((await sessionRow(other.sid)).revoked_at, "another session is untouched").toBeNull();
    },
  );

  it("FR-170-GRACE-10b · a slot that is not exactly a slot (unparseable, or missing a field) is an absent one — never a partial grant", async () => {
    const userId = await createUser();
    const sessions = harness.app().get(SessionService);
    const initial = await sessions.createSession(userId);
    await sessions.refresh(initial.refreshToken);
    const predecessorHash = hashRefreshToken(initial.refreshToken);

    await cache.set(slotKey(initial.sid), JSON.stringify({ predecessorHash }), { ttlMs: 60_000 });

    await expect(sessions.refresh(initial.refreshToken)).rejects.toThrow("refresh token already used");
  });

  it("FR-170-GRACE-10c · a slot whose predecessor hash is not the presented token's is refused even when its ciphertext would open — the hash is its own condition, not a side effect of the cipher", async () => {
    const userId = await createUser();
    const sessions = harness.app().get(SessionService);
    const initial = await sessions.createSession(userId);
    await sessions.refresh(initial.refreshToken);
    const slot = parseGraceSlot((await cache.get(slotKey(initial.sid)))!)!;

    // Same sealed successor — which THIS token can open — but the slot names
    // some other token as the predecessor.
    await cache.set(
      slotKey(initial.sid),
      serializeGraceSlot({ ...slot, predecessorHash: hashRefreshToken(generateRefreshToken()) }),
      { ttlMs: 60_000 },
    );

    await expect(sessions.refresh(initial.refreshToken)).rejects.toThrow("refresh token already used");
  });

  it("FR-170-GRACE-13 · the slot is written BEFORE the rotation commits — a racer queued on the token row's lock reads it the instant the commit releases it, even when the cache is slow", async () => {
    const userId = await createUser();
    const sessions = harness.app().get(SessionService);
    const initial = await sessions.createSession(userId);
    cache.delays.set("set", 400);
    const slotWriteStarted = new Promise<void>((resolve) => {
      cache.onEnter = (operation) => {
        if (operation === "set") resolve();
      };
    });

    const rotation = sessions.refresh(initial.refreshToken);
    // The rotation is at its slot write. If that write comes before the
    // commit, it is still holding the token row's lock and the racer below
    // queues behind it. If the write came AFTER the commit, the lock is
    // already free and the racer reads a cache the slow write has not reached.
    await slotWriteStarted;
    const racer = sessions.refresh(initial.refreshToken);

    const [rotated, raced] = await Promise.all([rotation, racer]);
    expect(raced.refreshToken).toBe(rotated.refreshToken);
    expect((await sessionRow(initial.sid)).revoked_at).toBeNull();
  });

  // The hard bound. The slot's TTL is the cache's promise, and a cache can
  // break it (a write abandoned at the deadline is still executed by Valkey
  // when it wakes, with a full TTL from then — session-refresh-grace-valkey
  // .spec.ts FR-170-GRACE-V6 shows that on a real Valkey). So Postgres carries
  // its own bound, on its own clock: the predecessor's consumed_at, stamped
  // by the rotation, must be younger than window + cache deadline. Here the
  // cache's clock is frozen (the slot is alive whatever happens) and only
  // Postgres's record of WHEN the rotation happened is moved.
  describe("the hard bound on the database's clock", () => {
    /** Moves the predecessor's consumption back in time on POSTGRES's clock. */
    async function consumedAgo(rawToken: string, ageMs: number): Promise<void> {
      const res = await pool.query(
        `UPDATE refresh_tokens SET consumed_at = clock_timestamp() - ($2::double precision * interval '1 millisecond')
          WHERE token_hash = $1 AND consumed_at IS NOT NULL`,
        [hashRefreshToken(rawToken), ageMs],
      );
      expect(res.rowCount, "the predecessor row was consumed and is now re-dated").toBe(1);
    }

    it("FR-170-GRACE-14a · a consumed token older than window + cache deadline on POSTGRES's clock is refused even though the cache still holds its live slot", async () => {
      const userId = await createUser();
      const sessions = harness.app().get(SessionService);
      const initial = await sessions.createSession(userId);
      await sessions.refresh(initial.refreshToken);
      expect(await cache.get(slotKey(initial.sid)), "the slot is alive on the cache's (frozen) clock").toBeDefined();

      await consumedAgo(initial.refreshToken, REFRESH_TOKEN_GRACE_WINDOW_DEFAULT_MS + REFRESH_TOKEN_GRACE_CACHE_DEADLINE_MS + 250);

      await expect(sessions.refresh(initial.refreshToken)).rejects.toThrow("refresh token already used");
      expect((await sessionRow(initial.sid)).revoked_reason).toBe("reuse_detected");
    });

    it("FR-170-GRACE-14b · just inside window + cache deadline it is still honoured — the bound is the window PLUS the deadline, because a slot write may legitimately take the whole deadline", async () => {
      const userId = await createUser();
      const sessions = harness.app().get(SessionService);
      const initial = await sessions.createSession(userId);
      const rotated = await sessions.refresh(initial.refreshToken);

      await consumedAgo(initial.refreshToken, REFRESH_TOKEN_GRACE_WINDOW_DEFAULT_MS + REFRESH_TOKEN_GRACE_CACHE_DEADLINE_MS - 250);

      const replay = await sessions.refresh(initial.refreshToken);
      expect(replay.refreshToken).toBe(rotated.refreshToken);
      expect((await sessionRow(initial.sid)).revoked_at).toBeNull();
    });

    it("FR-170-GRACE-14c · the bound follows the CONFIGURED window: with a 500ms window, a token consumed 1.2s ago (past 500ms + 500ms) is refused though 1.2s is inside the 2s default", async () => {
      process.env.REFRESH_TOKEN_GRACE_WINDOW_MS = "500";
      const userId = await createUser();
      const sessions = harness.app().get(SessionService);
      const initial = await sessions.createSession(userId);
      await sessions.refresh(initial.refreshToken);

      await consumedAgo(initial.refreshToken, 500 + REFRESH_TOKEN_GRACE_CACHE_DEADLINE_MS + 200);

      await expect(sessions.refresh(initial.refreshToken)).rejects.toThrow("refresh token already used");
    });

    it("FR-170-GRACE-14e · the bound is read AFTER the cache wait, on the live clock — a slow cache read that carries a replay past window + deadline refuses it, though it was inside the bound when the replay arrived", async () => {
      const userId = await createUser();
      const sessions = harness.app().get(SessionService);
      const initial = await sessions.createSession(userId);
      await sessions.refresh(initial.refreshToken);

      // 200ms inside the bound when the replay ARRIVES; the cache then takes
      // 400ms to answer, so by the time the decision is made it is 200ms over.
      // A bound read at the transaction's start (`now()`) would still see it as
      // inside.
      await consumedAgo(initial.refreshToken, REFRESH_TOKEN_GRACE_WINDOW_DEFAULT_MS + REFRESH_TOKEN_GRACE_CACHE_DEADLINE_MS - 200);
      cache.delays.set("get", 400);

      await expect(sessions.refresh(initial.refreshToken)).rejects.toThrow("refresh token already used");
      expect((await sessionRow(initial.sid)).revoked_reason).toBe("reuse_detected");
    });

    it("FR-170-GRACE-14d · the bound reads the PRESENTED token's own consumption — ageing one session's predecessor does not refuse another session's replay", async () => {
      // Two sessions rotated; only the FIRST session's predecessor is aged out.
      // The second session's own replay is unaffected.
      const userId = await createUser();
      const sessions = harness.app().get(SessionService);
      const old = await sessions.createSession(userId);
      const fresh = await sessions.createSession(userId);
      await sessions.refresh(old.refreshToken);
      const freshRotated = await sessions.refresh(fresh.refreshToken);

      await consumedAgo(old.refreshToken, REFRESH_TOKEN_GRACE_WINDOW_DEFAULT_MS + REFRESH_TOKEN_GRACE_CACHE_DEADLINE_MS + 250);

      const replay = await sessions.refresh(fresh.refreshToken);
      expect(replay.refreshToken).toBe(freshRotated.refreshToken);
      await expect(sessions.refresh(old.refreshToken)).rejects.toThrow("refresh token already used");
      expect((await sessionRow(fresh.sid)).revoked_at, "the other session survives").toBeNull();
    });
  });

  describe("cache unavailable — fail closed", () => {
    it("FR-170-GRACE-11a · every cache write fails: the rotation STILL succeeds (without a slot), the failure is logged and counted, and a replay revokes", async () => {
      const userId = await createUser();
      const sessions = harness.app().get(SessionService);
      const initial = await sessions.createSession(userId);
      cache.faults.set("set", "reject");
      const counterSpy = vi.spyOn(metrics, "incrementCounter");
      const warnSpy = vi.spyOn(Logger.prototype, "warn");

      const rotated = await sessions.refresh(initial.refreshToken);

      expect(rotated.refreshToken).not.toBe(initial.refreshToken);
      const successor = await pool.query(
        `SELECT 1 FROM refresh_tokens WHERE token_hash = $1 AND session_id = $2 AND consumed_at IS NULL`,
        [hashRefreshToken(rotated.refreshToken), initial.sid],
      );
      expect(successor.rows.length, "the rotation committed: the successor is a live token").toBe(1);
      expect(counterSpy).toHaveBeenCalledWith(
        "nominara_identity_session_refresh_grace_cache_failure_total",
        expect.objectContaining({ operation: "write" }),
      );
      const failureLog = warnSpy.mock.calls.find((call) => String(call[0]).includes("grace slot write failed"));
      expect(failureLog, "the cache failure is logged").toBeDefined();
      expect(String(failureLog![0])).toContain(initial.sid);

      cache.faults.clear();
      await expect(sessions.refresh(initial.refreshToken)).rejects.toThrow("refresh token already used");
      expect((await sessionRow(initial.sid)).revoked_reason).toBe("reuse_detected");
    });

    it("FR-170-GRACE-11b · the slot was written but the cache cannot be READ at the replay: the replay revokes rather than erroring or granting", async () => {
      const userId = await createUser();
      const sessions = harness.app().get(SessionService);
      const initial = await sessions.createSession(userId);
      await sessions.refresh(initial.refreshToken);
      cache.faults.set("get", "reject");
      const counterSpy = vi.spyOn(metrics, "incrementCounter");

      await expect(sessions.refresh(initial.refreshToken)).rejects.toThrow("refresh token already used");

      expect(counterSpy).toHaveBeenCalledWith(
        "nominara_identity_session_refresh_grace_cache_failure_total",
        expect.objectContaining({ operation: "read" }),
      );
      expect((await sessionRow(initial.sid)).revoked_reason).toBe("reuse_detected");
    });

    it("FR-170-GRACE-11c · a cache DELETE that fails cannot turn the reuse revocation into a different error", async () => {
      const userId = await createUser();
      const sessions = harness.app().get(SessionService);
      const initial = await sessions.createSession(userId);
      await sessions.refresh(initial.refreshToken);
      closeWindow();
      cache.faults.set("delete", "reject");

      await expect(sessions.refresh(initial.refreshToken)).rejects.toThrow("refresh token already used");
      expect((await sessionRow(initial.sid)).revoked_reason).toBe("reuse_detected");
    });

    it("FR-170-GRACE-11d · a failure never logs the error's message — a connection error can carry the cache URL and its credentials — nor any token", async () => {
      const userId = await createUser();
      const sessions = harness.app().get(SessionService);
      const initial = await sessions.createSession(userId);
      cache.faults.set("set", "reject");
      cache.faults.set("get", "reject");
      cache.faults.set("delete", "reject");
      const warnSpy = vi.spyOn(Logger.prototype, "warn");
      const counterSpy = vi.spyOn(metrics, "incrementCounter");

      const rotated = await sessions.refresh(initial.refreshToken);
      await expect(sessions.refresh(initial.refreshToken)).rejects.toThrow();

      const observed = [
        ...warnSpy.mock.calls.map((call) => String(call[0])),
        ...counterSpy.mock.calls.map((call) => JSON.stringify(call)),
      ].join("\n");
      expect(observed).toContain("failed");
      expect(observed).not.toContain(FAULT_ERROR_SECRET);
      expect(observed).not.toContain(initial.refreshToken);
      expect(observed).not.toContain(rotated.refreshToken);
    });

    it(
      "FR-170-GRACE-11e · a cache that accepts the call and NEVER answers costs the window, not the request: the rotation completes inside the deadline and a replay revokes",
      async () => {
        const userId = await createUser();
        const sessions = harness.app().get(SessionService);
        const initial = await sessions.createSession(userId);
        cache.faults.set("set", "hang");
        cache.faults.set("get", "hang");
        cache.faults.set("delete", "hang");

        const startedAt = performance.now();
        const rotated = await sessions.refresh(initial.refreshToken);
        const rotationMs = performance.now() - startedAt;
        expect(rotated.refreshToken).not.toBe(initial.refreshToken);
        // Bounded by the deadline (plus the rotation's own queries), not by the
        // cache. The slack is generous on purpose: this asserts "did not hang",
        // and a hang is unbounded.
        expect(rotationMs).toBeLessThan(REFRESH_TOKEN_GRACE_CACHE_DEADLINE_MS + 4_000);

        await expect(sessions.refresh(initial.refreshToken)).rejects.toThrow("refresh token already used");
        expect((await sessionRow(initial.sid)).revoked_reason).toBe("reuse_detected");
      },
      20_000,
    );
  });

  // A cache that accepts the call and goes quiet is paid for ONCE per cool-off
  // per process, not once per rotation. The deadline bounds one wait; without
  // this, N concurrent refreshes each hold a pool connection and row locks for
  // the whole deadline (measured on a 10-connection pool: an unrelated
  // `SELECT 1` waited ~2s behind 40 refreshes). While the breaker is open the
  // cache is not touched AT ALL — no slot written, none read — so a replay
  // revokes as the strict rule says. The cool-off is measured on the process's
  // monotonic clock, which these specs move with `skewMs`.
  describe("cache circuit breaker", () => {
    let skewMs = 0;
    let entered: CacheOperation[] = [];

    beforeEach(() => {
      skewMs = 0;
      entered = [];
      const realNow = performance.now.bind(performance);
      vi.spyOn(performance, "now").mockImplementation(() => realNow() + skewMs);
      cache.onEnter = (operation) => {
        entered.push(operation);
      };
    });

    const coolOff = (): void => {
      skewMs += REFRESH_TOKEN_GRACE_CACHE_COOLOFF_MS + 1;
    };
    const count = (operation: CacheOperation): number => entered.filter((entry) => entry === operation).length;
    async function waitFor(condition: () => boolean): Promise<void> {
      const giveUpAt = Date.now() + 5_000;
      while (!condition()) {
        if (Date.now() > giveUpAt) throw new Error("timed out waiting for a condition");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    async function timed<T>(work: Promise<T>): Promise<{ value: T; ms: number }> {
      const startedAt = performance.now();
      const value = await work;
      return { value, ms: performance.now() - startedAt };
    }

    it("FR-170-GRACE-15a · after a slot write misses its deadline, the NEXT rotation does not wait on the cache — it never touches it — and its replay revokes without a read", async () => {
      const userId = await createUser();
      const sessions = harness.app().get(SessionService);
      const first = await sessions.createSession(userId);
      const second = await sessions.createSession(userId);
      const counterSpy = vi.spyOn(metrics, "incrementCounter");
      cache.faults.set("set", "hang");
      cache.faults.set("get", "hang");

      const tripping = await timed(sessions.refresh(first.refreshToken));
      expect(tripping.ms, "the first rotation paid the deadline").toBeGreaterThanOrEqual(REFRESH_TOKEN_GRACE_CACHE_DEADLINE_MS - 50);
      expect(count("set")).toBe(1);

      const skipped = await timed(sessions.refresh(second.refreshToken));
      expect(skipped.value.refreshToken).not.toBe(second.refreshToken);
      expect(count("set"), "the second rotation never entered the cache").toBe(1);
      expect(skipped.ms, "and so did not wait on it").toBeLessThan(REFRESH_TOKEN_GRACE_CACHE_DEADLINE_MS - 100);
      expect(counterSpy).toHaveBeenCalledWith(
        "nominara_identity_session_refresh_grace_cache_skipped_total",
        expect.objectContaining({ operation: "write" }),
      );

      const replay = await timed(sessions.refresh(second.refreshToken).then(() => "granted", () => "revoked"));
      expect(replay.value).toBe("revoked");
      expect(count("get"), "no slot is read while the breaker is open").toBe(0);
      expect(replay.ms).toBeLessThan(REFRESH_TOKEN_GRACE_CACHE_DEADLINE_MS - 100);
      expect((await sessionRow(second.sid)).revoked_reason).toBe("reuse_detected");
      expect(counterSpy).toHaveBeenCalledWith(
        "nominara_identity_session_refresh_grace_cache_skipped_total",
        expect.objectContaining({ operation: "read" }),
      );
    });

    it("FR-170-GRACE-15b · once the cool-off has passed the cache is used again — a slot is written and a racer converges on the successor", async () => {
      const userId = await createUser();
      const sessions = harness.app().get(SessionService);
      const first = await sessions.createSession(userId);
      const second = await sessions.createSession(userId);
      const third = await sessions.createSession(userId);
      cache.faults.set("set", "hang");
      await sessions.refresh(first.refreshToken);
      await sessions.refresh(second.refreshToken);
      expect(count("set"), "still cooling off: the second rotation skipped the cache").toBe(1);

      cache.faults.clear();
      skewMs += REFRESH_TOKEN_GRACE_CACHE_COOLOFF_MS - 1_000;
      const stillCooling = await sessions.createSession(userId);
      await sessions.refresh(stillCooling.refreshToken);
      expect(count("set"), "1s before the cool-off ends the cache is still not touched").toBe(1);

      skewMs += 1_001;
      const rotated = await sessions.refresh(third.refreshToken);
      expect(count("set"), "the cool-off is over: this rotation used the cache").toBe(2);
      expect(await cache.get(slotKey(third.sid))).toBeDefined();
      const replay = await sessions.refresh(third.refreshToken);
      expect(replay.refreshToken).toBe(rotated.refreshToken);
    });

    it("FR-170-GRACE-15c · a cache ERROR opens it too, not only a missed deadline — and a cache that has since recovered is still left alone until the cool-off ends", async () => {
      const userId = await createUser();
      const sessions = harness.app().get(SessionService);
      const first = await sessions.createSession(userId);
      const second = await sessions.createSession(userId);
      cache.faults.set("set", "reject");
      await sessions.refresh(first.refreshToken);
      cache.faults.clear();

      await sessions.refresh(second.refreshToken);

      expect(count("set")).toBe(1);
      expect(await cache.get(slotKey(second.sid)), "no slot: the healthy cache was not written to during the cool-off").toBeUndefined();
      await expect(sessions.refresh(second.refreshToken)).rejects.toThrow("refresh token already used");
    });

    it("FR-170-GRACE-15d · a failed READ opens it as well — the next rotation writes no slot", async () => {
      const userId = await createUser();
      const sessions = harness.app().get(SessionService);
      const first = await sessions.createSession(userId);
      const second = await sessions.createSession(userId);
      await sessions.refresh(first.refreshToken);
      cache.faults.set("get", "hang");
      await expect(sessions.refresh(first.refreshToken)).rejects.toThrow("refresh token already used");
      cache.faults.clear();
      const setsBefore = count("set");

      await sessions.refresh(second.refreshToken);

      expect(count("set"), "the read failure opened the breaker: the write was skipped").toBe(setsBefore);
    });

    it("FR-170-GRACE-15e · when the cool-off ends exactly ONE call is let through to probe the cache — concurrent rotations keep skipping — and a failed probe restarts the cool-off", async () => {
      const userId = await createUser();
      const sessions = harness.app().get(SessionService);
      const tripping = await sessions.createSession(userId);
      const burst = await Promise.all(Array.from({ length: 5 }, () => sessions.createSession(userId)));
      const after = await sessions.createSession(userId);
      cache.faults.set("set", "hang");
      await sessions.refresh(tripping.refreshToken);
      expect(count("set")).toBe(1);

      coolOff();
      await Promise.all(burst.map((session) => sessions.refresh(session.refreshToken)));
      expect(count("set"), "five concurrent rotations, one probe").toBe(2);

      await sessions.refresh(after.refreshToken);
      expect(count("set"), "the probe missed its deadline: the cool-off started again").toBe(2);
    });

    it("FR-170-GRACE-15f · a successful probe CLOSES the breaker — the very next rotation uses the cache too, it is not left in a probing state", async () => {
      const userId = await createUser();
      const sessions = harness.app().get(SessionService);
      const tripping = await sessions.createSession(userId);
      const probing = await sessions.createSession(userId);
      const following = await sessions.createSession(userId);
      cache.faults.set("set", "reject");
      await sessions.refresh(tripping.refreshToken);
      cache.faults.clear();

      coolOff();
      await sessions.refresh(probing.refreshToken);
      expect(count("set"), "the probe went through").toBe(2);
      await sessions.refresh(following.refreshToken);

      expect(count("set"), "and it succeeded, so the cache is in use again").toBe(3);
      expect(await cache.get(slotKey(following.sid))).toBeDefined();

      // Closed, not merely "probing again": concurrent rotations ALL use the
      // cache. A breaker that stayed half-open would let one of them through
      // and make the rest skip.
      // The writes are slowed so the three genuinely overlap: a probe that
      // settles in a millisecond would let the others through one by one and
      // hide the difference.
      const concurrent = await Promise.all(Array.from({ length: 3 }, () => sessions.createSession(userId)));
      cache.delays.set("set", 150);
      await Promise.all(concurrent.map((session) => sessions.refresh(session.refreshToken)));
      expect(count("set"), "three concurrent rotations, three cache writes").toBe(6);
    });

    // Round-3 audit, MINOR: nothing pinned that the breaker can never get stuck
    // OPEN. Deleting the reset of the in-probe flag after a probe passed every
    // other test, and left grace disabled for the life of the process after the
    // first failed probe (fail-closed, so availability rather than security).
    it("FR-170-GRACE-15j · the breaker cannot get stuck open: a failed probe, then a later probe is admitted and closes it; it can re-open and probe again", async () => {
      const userId = await createUser();
      const sessions = harness.app().get(SessionService);
      const s = await Promise.all(Array.from({ length: 6 }, () => sessions.createSession(userId)));

      cache.faults.set("set", "reject");
      await sessions.refresh(s[0]!.refreshToken); // opens
      coolOff();
      await sessions.refresh(s[1]!.refreshToken); // probe #1 fails, cool-off restarts
      expect(count("set"), "the first probe was attempted").toBe(2);

      cache.faults.clear();
      coolOff();
      await sessions.refresh(s[2]!.refreshToken); // probe #2 must be admitted
      expect(count("set"), "a second probe is admitted after a failed one").toBe(3);
      await sessions.refresh(s[3]!.refreshToken); // it succeeded: closed
      expect(count("set"), "and it closed the breaker").toBe(4);

      cache.faults.set("set", "reject");
      await sessions.refresh(s[4]!.refreshToken); // re-opens
      cache.faults.clear();
      coolOff();
      await sessions.refresh(s[5]!.refreshToken); // probe #3 admitted
      expect(count("set"), "a re-opened breaker probes again").toBe(6);
    });

    it("FR-170-GRACE-15i · a call that was already in flight when the breaker opened, and that then SUCCEEDS, does not close it — only the probe does", async () => {
      const userId = await createUser();
      const sessions = harness.app().get(SessionService);
      const slow = await sessions.createSession(userId);
      const failing = await sessions.createSession(userId);
      const after = await sessions.createSession(userId);

      // `slow`'s write enters a healthy-but-slow cache and will succeed 400ms on.
      cache.delays.set("set", 400);
      const slowRotation = sessions.refresh(slow.refreshToken);
      await waitFor(() => count("set") === 1);

      // While it is in flight another write fails, which opens the breaker.
      cache.delays.delete("set");
      cache.faults.set("set", "reject");
      await sessions.refresh(failing.refreshToken);
      cache.faults.clear();
      expect(count("set")).toBe(2);
      await slowRotation;

      await sessions.refresh(after.refreshToken);
      expect(count("set"), "the slow success did not reopen the cache: still cooling off").toBe(2);
    });

    it("FR-170-GRACE-15g · opening the breaker is logged ONCE however many in-flight calls miss together, with no token in it, and every skipped call is counted", async () => {
      const userId = await createUser();
      const sessions = harness.app().get(SessionService);
      const burst = await Promise.all(Array.from({ length: 3 }, () => sessions.createSession(userId)));
      const after = await sessions.createSession(userId);
      const warnSpy = vi.spyOn(Logger.prototype, "warn");
      const counterSpy = vi.spyOn(metrics, "incrementCounter");
      cache.faults.set("set", "hang");

      // Three rotations reach the silent cache together, so all three are
      // admitted and all three miss their deadline: three failures, one opening.
      const rotated = await Promise.all(burst.map((session) => sessions.refresh(session.refreshToken)));
      expect(count("set")).toBe(3);
      await sessions.refresh(after.refreshToken);

      const opened = warnSpy.mock.calls.filter((call) => String(call[0]).includes("circuit open"));
      expect(opened, "one line for the transition, none per failure or per skipped call").toHaveLength(1);
      expect(String(opened[0]![0])).toContain(String(REFRESH_TOKEN_GRACE_CACHE_COOLOFF_MS));
      const observed = [
        ...warnSpy.mock.calls.map((call) => String(call[0])),
        ...counterSpy.mock.calls.map((call) => JSON.stringify(call)),
      ].join("\n");
      for (const token of [...burst, after, ...rotated].map((session) => session.refreshToken)) {
        expect(observed).not.toContain(token);
      }
      const skips = counterSpy.mock.calls.filter(
        (call) => call[0] === "nominara_identity_session_refresh_grace_cache_skipped_total",
      );
      expect(skips, "the one rotation that found the breaker open").toHaveLength(1);
      expect(skips[0]![1]).toEqual({ operation: "write" });
    });

    it(
      "FR-170-GRACE-15h · with a silent cache and the breaker open, 40 concurrent refreshes on a 10-connection pool leave an unrelated query on the same pool unblocked",
      async () => {
        const smallPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
        try {
          const sessions = new SessionService(smallPool, new MembershipService(new MembershipCacheService()), cache);
          const userId = await createUser();
          const tripping = await sessions.createSession(userId);
          const created = [];
          for (let i = 0; i < 40; i++) created.push(await sessions.createSession(userId));
          cache.faults.set("set", "hang");
          await sessions.refresh(tripping.refreshToken);
          expect(count("set")).toBe(1);

          const rotations = Promise.all(created.map((session) => sessions.refresh(session.refreshToken)));
          await new Promise((resolve) => setTimeout(resolve, 20));
          const unrelated = await timed(smallPool.query("SELECT 1"));
          await rotations;

          expect(count("set"), "not one of the 40 waited on the cache").toBe(1);
          expect(unrelated.ms).toBeLessThan(REFRESH_TOKEN_GRACE_CACHE_DEADLINE_MS / 2);
        } finally {
          await smallPool.end();
        }
      },
      60_000,
    );
  });

  describe("what a database read can reach", () => {
    interface ColumnRow {
      table_schema: string;
      table_name: string;
      column_name: string;
    }

    async function columns(): Promise<ColumnRow[]> {
      const res = await pool.query<ColumnRow>(
        `SELECT c.table_schema, c.table_name, c.column_name
           FROM information_schema.columns c
           JOIN information_schema.tables t
             ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
          WHERE c.table_schema IN ('public', 'app')`,
      );
      return res.rows;
    }

    it("FR-170-GRACE-12 · no table carries a grace, successor or predecessor column, and sessions/refresh_tokens hold exactly the columns they held before the window existed", async () => {
      const all = await columns();

      expect(all.filter((c) => /grace|successor|predecessor/i.test(c.column_name))).toEqual([]);
      const namesOf = (table: string): string[] =>
        all
          .filter((c) => c.table_schema === "public" && c.table_name === table)
          .map((c) => c.column_name)
          .sort();
      expect(namesOf("sessions")).toEqual(
        [
          "active_workspace_id",
          "created_at",
          "id",
          "last_strong_auth_at",
          "last_strong_auth_method",
          "last_used_at",
          "revoked_at",
          "revoked_reason",
          "user_id",
        ].sort(),
      );
      expect(namesOf("refresh_tokens")).toEqual(
        ["consumed_at", "created_at", "expires_at", "id", "session_id", "token_hash"].sort(),
      );
    });

    it("FR-170-GRACE-12b · after a rotation, neither the successor, the predecessor, nor the sealed slot appears in ANY row of ANY table — a database read cannot reach a live refresh token", async () => {
      const userId = await createUser();
      const sessions = harness.app().get(SessionService);
      const initial = await sessions.createSession(userId);
      const rotated = await sessions.refresh(initial.refreshToken);
      const slot = parseGraceSlot((await cache.get(slotKey(initial.sid)))!);
      expect(slot, "a slot exists to be looked for").toBeDefined();

      const needles = [rotated.refreshToken, initial.refreshToken, slot!.successorCiphertext];
      const tables = new Set((await columns()).map((c) => `${c.table_schema}.${c.table_name}`));
      const quote = (identifier: string): string => `"${identifier.replaceAll('"', '""')}"`;
      const offenders: string[] = [];
      for (const qualified of tables) {
        const [schema, table] = qualified.split(".") as [string, string];
        const rows = await pool.query<{ row_text: string }>(`SELECT t::text AS row_text FROM ${quote(schema)}.${quote(table)} t`);
        for (const row of rows.rows) {
          if (needles.some((needle) => row.row_text.includes(needle))) offenders.push(qualified);
        }
      }
      expect(offenders).toEqual([]);
      // ...and the tokens' HASHES are what the database does hold.
      const hashes = await pool.query(`SELECT 1 FROM refresh_tokens WHERE token_hash IN ($1, $2)`, [
        hashRefreshToken(rotated.refreshToken),
        hashRefreshToken(initial.refreshToken),
      ]);
      expect(hashes.rows.length).toBe(2);
    });
  });
});
