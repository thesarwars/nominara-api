import { Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionService } from "../../src/modules/identity/session.service.js";
import { MembershipService } from "../../src/modules/workspaces/membership.service.js";
import { REFRESH_TOKEN_GRACE_WINDOW_DEFAULT_MS } from "../../src/lib/auth/refresh-token.js";
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
// Real Postgres through the real, deployed ApiModule (useApiHarness) — same
// reasoning as session-refresh-keeps-workspace.spec.ts's own header: the
// workspace re-verification a grace hit ALSO runs opens its own
// withTenantContext transactions via MembershipService, which cannot be
// trusted against a mocked pg client.
describe("STORY-170 · refresh-token reuse grace window", () => {
  const harness = useApiHarness();
  let pool: Pool;

  beforeEach(() => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
  });

  afterEach(async () => {
    await pool.end();
  });

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

  interface GraceRow {
    revoked_at: Date | null;
    revoked_reason: string | null;
    refresh_grace_predecessor_hash: string | null;
    refresh_grace_successor_ciphertext: string | null;
    refresh_grace_expires_at: Date | null;
  }

  async function sessionRow(sid: string): Promise<GraceRow> {
    const res = await pool.query<GraceRow>(
      `SELECT revoked_at, revoked_reason, refresh_grace_predecessor_hash, refresh_grace_successor_ciphertext, refresh_grace_expires_at
         FROM sessions WHERE id = $1`,
      [sid],
    );
    return res.rows[0]!;
  }

  function afterWindow(base: Date): Date {
    return new Date(base.getTime() + REFRESH_TOKEN_GRACE_WINDOW_DEFAULT_MS + 1_000);
  }

  it("FR-170-GRACE-1 · a second refresh with the same, just-consumed token INSIDE the window gets the identical successor — the session stays alive", async () => {
    const now = new Date();
    const userId = await createUser();
    const sessions = harness.app().get(SessionService);
    const initial = await sessions.createSession(userId);

    const rotated = await sessions.refresh(initial.refreshToken, now);
    const replay = await sessions.refresh(initial.refreshToken, new Date(now.getTime() + 10));

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
    const now = new Date();
    const userId = await createUser();
    const sessions = harness.app().get(SessionService);
    const initial = await sessions.createSession(userId);

    const rotated = await sessions.refresh(initial.refreshToken, now);
    const secondReplay = await sessions.refresh(initial.refreshToken, new Date(now.getTime() + 5));
    const thirdReplay = await sessions.refresh(initial.refreshToken, new Date(now.getTime() + 10));

    expect(secondReplay.refreshToken).toBe(rotated.refreshToken);
    expect(thirdReplay.refreshToken).toBe(rotated.refreshToken);
  });

  it("FR-170-GRACE-2 · a grace-window hit is audited as session.refresh_grace_reuse, naming the session id and never a raw token", async () => {
    const now = new Date();
    const userId = await createUser();
    const sessions = harness.app().get(SessionService);
    const initial = await sessions.createSession(userId);
    const counterSpy = vi.spyOn(metrics, "incrementCounter");
    const warnSpy = vi.spyOn(Logger.prototype, "warn");

    const rotated = await sessions.refresh(initial.refreshToken, now);
    const replay = await sessions.refresh(initial.refreshToken, new Date(now.getTime() + 10));

    expect(counterSpy).toHaveBeenCalledWith(
      "nominara_identity_session_refresh_grace_reuse_total",
      expect.objectContaining({ session_id: initial.sid }),
    );
    // Never the reuse_detected event for a grace-window hit.
    expect(counterSpy).not.toHaveBeenCalledWith("nominara_identity_session_reuse_detected_total", expect.anything());

    const graceWarnCall = warnSpy.mock.calls.find((call) => String(call[0]).includes("grace-window reuse"));
    expect(graceWarnCall, "expected a grace-window reuse warn log line").toBeDefined();
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
    const now = new Date();
    const userId = await createUser();
    const sessions = harness.app().get(SessionService);
    const initial = await sessions.createSession(userId);
    const counterSpy = vi.spyOn(metrics, "incrementCounter");

    await sessions.refresh(initial.refreshToken, now);

    await expect(sessions.refresh(initial.refreshToken, afterWindow(now))).rejects.toThrow(
      "refresh token already used",
    );

    expect(counterSpy).toHaveBeenCalledWith(
      "nominara_identity_session_reuse_detected_total",
      expect.objectContaining({ session_id: initial.sid }),
    );
    const row = await sessionRow(initial.sid);
    expect(row.revoked_at).not.toBeNull();
    expect(row.revoked_reason).toBe("reuse_detected");
  });

  it("FR-170-GRACE-4 · an older (two-back) token still revokes even though it is presented inside what is now a DIFFERENT rotation's grace window", async () => {
    const now = new Date();
    const userId = await createUser();
    const sessions = harness.app().get(SessionService);
    const initial = await sessions.createSession(userId);

    // A -> B (consumes A, opens A's grace window).
    const afterFirst = await sessions.refresh(initial.refreshToken, now);
    // B -> C (consumes B, opens B's grace window — the ONE grace slot this
    // session has now describes B, not A).
    await sessions.refresh(afterFirst.refreshToken, new Date(now.getTime() + 5));

    // Replay A, ten ms later — comfortably inside the DEFAULT window's
    // duration, but A is no longer "the immediately preceding rotation"'s
    // token (B is), so this must still revoke.
    await expect(sessions.refresh(initial.refreshToken, new Date(now.getTime() + 10))).rejects.toThrow(
      "refresh token already used",
    );

    const row = await sessionRow(initial.sid);
    expect(row.revoked_at).not.toBeNull();
    expect(row.revoked_reason).toBe("reuse_detected");
  });

  it("FR-170-GRACE-5 · the stored successor ciphertext is gone once the window has closed and the stale token is presented again", async () => {
    const now = new Date();
    const userId = await createUser();
    const sessions = harness.app().get(SessionService);
    const initial = await sessions.createSession(userId);

    await sessions.refresh(initial.refreshToken, now);
    const rowInsideWindow = await sessionRow(initial.sid);
    expect(rowInsideWindow.refresh_grace_successor_ciphertext).not.toBeNull();
    expect(rowInsideWindow.refresh_grace_predecessor_hash).not.toBeNull();
    expect(rowInsideWindow.refresh_grace_expires_at).not.toBeNull();

    await expect(sessions.refresh(initial.refreshToken, afterWindow(now))).rejects.toThrow();

    const rowAfterWindow = await sessionRow(initial.sid);
    expect(rowAfterWindow.refresh_grace_successor_ciphertext).toBeNull();
    expect(rowAfterWindow.refresh_grace_predecessor_hash).toBeNull();
    expect(rowAfterWindow.refresh_grace_expires_at).toBeNull();
  });

  it("FR-170-GRACE-6 · the stored successor ciphertext is replaced (never left describing the OLD predecessor) by the session's next rotation", async () => {
    const now = new Date();
    const userId = await createUser();
    const sessions = harness.app().get(SessionService);
    const initial = await sessions.createSession(userId);

    const afterFirst = await sessions.refresh(initial.refreshToken, now);
    const rowAfterFirst = await sessionRow(initial.sid);
    const firstCiphertext = rowAfterFirst.refresh_grace_successor_ciphertext;
    expect(firstCiphertext).not.toBeNull();

    // A legitimate next rotation, using the CURRENT valid token — not a
    // replay of anything.
    await sessions.refresh(afterFirst.refreshToken, new Date(now.getTime() + 5));
    const rowAfterSecond = await sessionRow(initial.sid);

    expect(rowAfterSecond.refresh_grace_successor_ciphertext).not.toBeNull();
    expect(rowAfterSecond.refresh_grace_successor_ciphertext).not.toBe(firstCiphertext);
    // The slot now names the token consumed by the SECOND rotation, not the
    // first — the old predecessor is no longer grace-eligible at all,
    // regardless of timing (FR-170-GRACE-4 proves the reuse consequence).
    expect(rowAfterSecond.refresh_grace_predecessor_hash).not.toBe(rowAfterFirst.refresh_grace_predecessor_hash);
  });

  it("FR-170-GRACE-7 · the workspace re-verification STORY-170 added still runs on a grace hit — a role downgraded between the rotation and the grace replay is reflected immediately, never the stale role", async () => {
    const now = new Date();
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

    const rotated = await owner.refresh(memberInitial.refreshToken, now);
    expect((await decode(rotated.accessToken)).role).toBe("admin");

    const membership = harness.app().get(MembershipService);
    await membership.updateRole(pool, workspaceId, memberId, "viewer");

    const graceHit = await owner.refresh(memberInitial.refreshToken, new Date(now.getTime() + 10));
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
});
