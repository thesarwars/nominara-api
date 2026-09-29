import { Inject, Injectable, Logger, UnauthorizedException } from "@nestjs/common";
import type { ClientBase, Pool } from "pg";
import { loadEnv } from "../../config/env.js";
import { PG_POOL } from "../../db/pg-pool.js";
import { importEd25519PrivateKeyFromDer, signAccessToken } from "../../lib/auth/access-token.js";
import { computeCsrfToken } from "../../lib/auth/csrf.js";
import { REFRESH_TOKEN_TTL_MS, generateRefreshToken, hashRefreshToken } from "../../lib/auth/refresh-token.js";
import { uuidV7 } from "../../lib/ids/uuidv7.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { isWorkspaceUsable, MembershipService } from "../workspaces/membership.service.js";

// STORY-017 — dangerous area: rotation and reuse-detection logic. Full
// history is checked (each refresh_tokens row is a distinct issued
// instance, never overwritten), not just "the previous token" — so theft
// from two or more rotations back is still caught as reuse. Every mutating
// step runs inside a single BEGIN/COMMIT transaction with `SELECT ... FOR
// UPDATE` on the row being consumed, so a raced double-refresh of the same
// token can never both succeed. A workspace switch never reads `ws` from
// client-supplied input — the new access token always mints ws/role/scope/
// ent_v fresh from server-side state the caller passed in explicitly.
//
// STORY-170 — security-and-tenancy.md §5 "`ws` is the active workspace;
// switching workspaces mints a new token" and §7 "a mismatch forces a token
// refresh" (only a real recovery path if refresh ITSELF keeps the
// workspace). `switchWorkspace` records the target on `sessions
// .active_workspace_id` (migration 0029) in the same transaction as the
// membership/revocation check below; `refresh` re-reads that column and
// RE-VERIFIES it — live membership, current role/scope, live
// entitlement_version — exactly as WorkspaceGuard/WorkspacesService.switchTo
// do, via the same MembershipService seam (membership.service.ts's own
// comment: "ONE DEFINITION, BECAUSE STORY-153 MADE THE DUPLICATE
// LOAD-BEARING"). Never carries role/scope/ent_v over from the OLD token —
// a role downgrade, a plan change, or a removed membership between switch
// and refresh must all show up in the very first token refresh mints.
// Fails closed: an unverifiable workspace mints ws:null and clears the
// column, the same outcome sign-in already produces.
//
// ⚠ VERIFICATION RUNS BEFORE `BEGIN`, NEVER WHILE A CONNECTION FROM THIS
// SAME POOL IS ALREADY CHECKED OUT. The first version called the
// MembershipService re-check (two more `pool.connect()`s) from INSIDE
// `refresh`'s own rotation transaction — i.e. while `client`, checked out of
// the very same `this.pool`, was already open and holding `FOR UPDATE` locks
// on `refresh_tokens`/`sessions`. `createPgPool` sets no
// `connectionTimeoutMillis` (run-estimate.service.ts's own header names the
// same trap), so at `pool.max` concurrently refreshing SWITCHED sessions
// every outer connection is a transaction waiting on an inner `connect()`
// that can only be satisfied by a connection one of the OTHER waiters is
// holding — the pool starves itself permanently, and because every route on
// the instance shares `PG_POOL`, the blast radius is every route, not just
// `/auth/refresh` (reproduced on `createPgPool` defaults: 10 concurrent
// switched-session refreshes deadlock the pool and an unrelated
// `pool.query('SELECT 1')` hangs with them).
//
// The fix: `verifyWorkspaceContext` below reads and re-verifies the
// workspace BEFORE any connection for the rotation is taken, on plain,
// auto-releasing `pool.query`/`MembershipService` calls that are sequential
// with each other and never nested inside a held connection. Only the
// SINGLE conditional write this produces (`finalizeWorkspaceContext`
// clearing a stale `active_workspace_id`) runs on the rotation's own
// `client`, because it already owns that connection and the row lock. A
// switch that races in between the pre-read and the rotation's own
// `FOR UPDATE` on `sessions` is caught by comparing the two observations
// (`finalizeWorkspaceContext`'s mismatch branch) rather than trusted stale:
// it mints `ws:null` for this one refresh WITHOUT clearing the column, so
// the switch's own value survives for the next refresh to verify fresh.
//
// This restructuring also closes a second, correctness gap for free: a
// transient failure inside verification (the membership service throwing,
// not just returning "unusable") now happens before `BEGIN` — nothing has
// rotated yet, so the caller's presented refresh token is untouched and a
// retry with the SAME token succeeds. The previous, in-transaction
// placement rolled the whole rotation back on such a failure too, but only
// because it happened to run before COMMIT; moving verification to where it
// no longer needs the rotation's connection at all makes that safety a
// structural property instead of an ordering coincidence.

export interface SessionTokens {
  readonly sid: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly csrfToken: string;
}

@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly membership: MembershipService,
  ) {}

  private async mintAccessAndCsrf(
    sid: string,
    userId: string,
    now: Date,
    ws: string | null = null,
    role: string | null = null,
    scope: readonly string[] | null = null,
    entV: number | null = null,
  ): Promise<{ accessToken: string; csrfToken: string }> {
    const env = loadEnv();
    const privateKey = importEd25519PrivateKeyFromDer(env.AUTH_TOKEN_ED25519_PRIVATE_KEY);
    const { token: accessToken } = await signAccessToken(
      { sub: userId, sid, ws, role, scope, entV },
      privateKey,
      env.AUTH_TOKEN_ED25519_KID,
      now,
    );
    const csrfToken = computeCsrfToken(sid, env.CSRF_SECRET);
    return { accessToken, csrfToken };
  }

  /** New session at authentication time. Workspace context starts empty — a real workspace is only ever entered via switchWorkspace. */
  async createSession(userId: string, now: Date = new Date()): Promise<SessionTokens> {
    const sid = uuidV7();
    const rawRefreshToken = generateRefreshToken();
    const expiresAt = new Date(now.getTime() + REFRESH_TOKEN_TTL_MS);

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`INSERT INTO sessions (id, user_id) VALUES ($1, $2)`, [sid, userId]);
      await client.query(
        `INSERT INTO refresh_tokens (id, session_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)`,
        [uuidV7(), sid, hashRefreshToken(rawRefreshToken), expiresAt],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }

    const { accessToken, csrfToken } = await this.mintAccessAndCsrf(sid, userId, now);
    return { sid, accessToken, refreshToken: rawRefreshToken, csrfToken };
  }

  /**
   * Rotates the presented refresh token. Presenting an already-consumed
   * token (scenario 4) revokes the entire session family and raises a
   * security event, rather than just rejecting the one token.
   */
  async refresh(rawRefreshToken: string, now: Date = new Date()): Promise<SessionTokens> {
    const tokenHash = hashRefreshToken(rawRefreshToken);

    // STORY-170 — see this file's header. Read and verify BEFORE taking the
    // rotation's connection: a plain `pool.query` (auto-acquires, runs,
    // releases) followed by `verifyWorkspaceContext`'s own sequential,
    // auto-releasing calls, so nothing here ever holds one connection from
    // `this.pool` while asking it for a second. `preActiveWorkspaceId` is
    // the value observed at THIS moment — `finalizeWorkspaceContext` below
    // re-compares it against what the rotation's own `FOR UPDATE` sees,
    // because a `switchWorkspace` can race in between.
    const preRead = await this.pool.query<{ user_id: string; active_workspace_id: string | null }>(
      `SELECT s.user_id, s.active_workspace_id
         FROM refresh_tokens rt
         JOIN sessions s ON s.id = rt.session_id
        WHERE rt.token_hash = $1`,
      [tokenHash],
    );
    const preRow = preRead.rows[0];
    const preActiveWorkspaceId = preRow?.active_workspace_id ?? null;
    const preVerified =
      preRow !== undefined && preActiveWorkspaceId !== null
        ? await this.verifyWorkspaceContext(preRow.user_id, preActiveWorkspaceId)
        : null;

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const tokenResult = await client.query<{
        id: string;
        session_id: string;
        consumed_at: Date | null;
        expires_at: Date;
      }>(`SELECT id, session_id, consumed_at, expires_at FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE`, [
        tokenHash,
      ]);
      const tokenRow = tokenResult.rows[0];
      if (!tokenRow) {
        throw new UnauthorizedException("invalid refresh token");
      }

      if (tokenRow.consumed_at !== null) {
        await client.query(
          `UPDATE sessions SET revoked_at = now(), revoked_reason = 'reuse_detected' WHERE id = $1 AND revoked_at IS NULL`,
          [tokenRow.session_id],
        );
        await client.query("COMMIT");
        this.logger.warn(`refresh token reuse detected — session family revoked session_id=${tokenRow.session_id}`);
        incrementCounter("nominara_identity_session_reuse_detected_total", { session_id: tokenRow.session_id });
        throw new UnauthorizedException("refresh token already used");
      }

      if (tokenRow.expires_at.getTime() <= now.getTime()) {
        throw new UnauthorizedException("refresh token expired");
      }

      const sessionResult = await client.query<{
        id: string;
        user_id: string;
        revoked_at: Date | null;
        active_workspace_id: string | null;
      }>(`SELECT id, user_id, revoked_at, active_workspace_id FROM sessions WHERE id = $1 FOR UPDATE`, [
        tokenRow.session_id,
      ]);
      const sessionRow = sessionResult.rows[0];
      if (!sessionRow || sessionRow.revoked_at !== null) {
        throw new UnauthorizedException("session revoked");
      }

      await client.query(`UPDATE refresh_tokens SET consumed_at = now() WHERE id = $1`, [tokenRow.id]);

      const rawNewRefreshToken = generateRefreshToken();
      const expiresAt = new Date(now.getTime() + REFRESH_TOKEN_TTL_MS);
      await client.query(
        `INSERT INTO refresh_tokens (id, session_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)`,
        [uuidV7(), sessionRow.id, hashRefreshToken(rawNewRefreshToken), expiresAt],
      );
      await client.query(`UPDATE sessions SET last_used_at = now() WHERE id = $1`, [sessionRow.id]);

      // STORY-170 — the verification already ran, above, BEFORE this
      // transaction's connection was even taken (see this file's header).
      // All that is left is to reconcile what was observed then
      // (`preActiveWorkspaceId`/`preVerified`) against what THIS row lock
      // sees now, and — only when reconciliation calls for it — clear a
      // stale `active_workspace_id` on the connection this transaction
      // already holds. No second connection is acquired here, so nothing
      // below can contend with another in-flight refresh for one.
      const active = await this.finalizeWorkspaceContext(
        client,
        sessionRow.id,
        sessionRow.active_workspace_id,
        preActiveWorkspaceId,
        preVerified,
      );

      await client.query("COMMIT");

      const { accessToken, csrfToken } = await this.mintAccessAndCsrf(
        sessionRow.id,
        sessionRow.user_id,
        now,
        active.ws,
        active.role,
        active.scope,
        active.entV,
      );
      return { sid: sessionRow.id, accessToken, refreshToken: rawNewRefreshToken, csrfToken };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * STORY-170 — the same five-condition usability check and live-membership
   * re-check `WorkspaceGuard`/`WorkspacesService.switchTo` run on every
   * request, applied here so a token refresh can never mint role/scope/ent_v
   * that are stale relative to the live database.
   *
   * Deliberately takes NO `client` and opens NO transaction of its own: it
   * runs entirely on sequential, auto-releasing `MembershipService` calls
   * against `this.pool`, called from `refresh()` BEFORE that method's own
   * rotation connection is checked out (this file's header explains why —
   * the pool-starvation defect this restructuring fixes). Returns `null`
   * both when there is nothing usable to verify and when verification
   * itself fails; the caller (`finalizeWorkspaceContext`) treats both the
   * same way, which is the fail-closed contract sign-in already produces.
   * A throw from either `MembershipService` call propagates straight out of
   * `refresh()` here, before any rotation has begun.
   */
  private async verifyWorkspaceContext(
    userId: string,
    workspaceId: string,
  ): Promise<{ ws: string; role: string | null; scope: readonly string[] | null; entV: number } | null> {
    const workspace = await this.membership.getWorkspaceStatus(this.pool, workspaceId);
    if (!isWorkspaceUsable(workspace)) {
      return null;
    }
    const live = await this.membership.getLiveMembership(this.pool, userId, workspaceId);
    if (!live || live.status !== "active") {
      return null;
    }
    return { ws: workspaceId, role: live.role, scope: live.projectScope, entV: workspace.entitlementVersion };
  }

  /**
   * STORY-170 — reconciles what `verifyWorkspaceContext` observed BEFORE the
   * rotation's connection was taken against what THIS row lock
   * (`sessionActiveWorkspaceId`, read under `refresh()`'s own
   * `SELECT ... FOR UPDATE`) sees now, and performs the one write that
   * reconciliation can call for — on `client`, the connection this
   * transaction already holds, never a new one.
   *
   * - No active workspace at all: nothing to verify or clear.
   * - The row lock's value differs from the value verification observed: a
   *   `switchWorkspace` raced in (either direction) between the two reads.
   *   Mint `ws:null` for THIS refresh without touching the column — the
   *   racing switch's own value is left standing for the next refresh to
   *   verify fresh, rather than being clobbered by a decision made against
   *   a value that is already stale.
   * - The values agree and verification succeeded: mint that context.
   * - The values agree and verification failed: clear `active_workspace_id`
   *   back to NULL, guarded by `WHERE active_workspace_id = $2` — the value
   *   this call is acting on — so a switch that lands in the instant between
   *   this comparison and the write still cannot be clobbered.
   */
  private async finalizeWorkspaceContext(
    client: ClientBase,
    sid: string,
    sessionActiveWorkspaceId: string | null,
    preActiveWorkspaceId: string | null,
    preVerified: { ws: string; role: string | null; scope: readonly string[] | null; entV: number } | null,
  ): Promise<{ ws: string | null; role: string | null; scope: readonly string[] | null; entV: number | null }> {
    if (sessionActiveWorkspaceId === null) {
      return { ws: null, role: null, scope: null, entV: null };
    }

    if (sessionActiveWorkspaceId !== preActiveWorkspaceId) {
      return { ws: null, role: null, scope: null, entV: null };
    }

    if (preVerified !== null) {
      return preVerified;
    }

    await client.query(`UPDATE sessions SET active_workspace_id = NULL WHERE id = $1 AND active_workspace_id = $2`, [
      sid,
      sessionActiveWorkspaceId,
    ]);
    return { ws: null, role: null, scope: null, entV: null };
  }

  /**
   * Service-level only (no HTTP route — STORY-018's WorkspaceGuard owns the
   * real membership-checked `/workspaces/{id}/switch` endpoint). Proves the
   * mint mechanism: same sid, new ws/role/scope/ent_v.
   */
  async switchWorkspace(
    sid: string,
    userId: string,
    ws: string,
    role: string | null,
    scope: readonly string[] | null,
    entV: number | null,
    now: Date = new Date(),
  ): Promise<{ accessToken: string; csrfToken: string }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{ revoked_at: Date | null }>(
        `SELECT revoked_at FROM sessions WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [sid, userId],
      );
      const row = result.rows[0];
      if (!row || row.revoked_at !== null) {
        throw new UnauthorizedException("session revoked");
      }
      // STORY-170 — recorded in the SAME transaction as the revocation check
      // above, under a `FOR UPDATE` on the same `sessions` row `refresh()`
      // locks. Whether or not that interleaves with a concurrent refresh is
      // NOT relied on for correctness here: `refresh()`'s own
      // `finalizeWorkspaceContext` re-compares the value it verified before
      // its rotation began against whatever this write leaves behind, and
      // fails closed to `ws:null` (without clobbering this column) on any
      // mismatch — so a race either way is handled explicitly rather than
      // assumed away by lock ordering.
      await client.query(`UPDATE sessions SET active_workspace_id = $2 WHERE id = $1`, [sid, ws]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }

    return this.mintAccessAndCsrf(sid, userId, now, ws, role, scope, entV);
  }

  /**
   * STORY-019 — test seam only, same precedent as STORY-018-E-5's
   * MembershipService.removeMember/updateRole: there is no real step-up
   * re-verification HTTP endpoint in this story (a documented follow-up,
   * not built here). Lets RbacGuard's step-up tests set up a session with a
   * real last_strong_auth_at/method instead of simulating the column.
   */
  async recordStrongAuth(sessionId: string, method: "webauthn", at: Date = new Date()): Promise<void> {
    await this.pool.query("UPDATE sessions SET last_strong_auth_at = $2, last_strong_auth_method = $3 WHERE id = $1", [
      sessionId,
      at,
      method,
    ]);
  }

  /** Revokes the family and adds the current jti to the deny list for its remaining lifetime (sessions.revoked_at IS the deny list). */
  async logout(sid: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(
        `UPDATE sessions SET revoked_at = now(), revoked_reason = 'logout' WHERE id = $1 AND revoked_at IS NULL`,
        [sid],
      );
    } finally {
      client.release();
    }
  }
}
