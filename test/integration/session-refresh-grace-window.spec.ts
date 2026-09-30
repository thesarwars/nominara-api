import { Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionService } from "../../src/modules/identity/session.service.js";
import { MembershipService } from "../../src/modules/workspaces/membership.service.js";
import {
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
import { FAULT_ERROR_SECRET, FaultInjectingCache } from "../support/fault-injecting-cache.js";
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
