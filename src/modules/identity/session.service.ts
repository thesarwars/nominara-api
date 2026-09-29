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

      // STORY-170 — BEFORE the commit below, deliberately, and NOT because
      // the read itself needs the transaction (MembershipService opens its
      // own short-lived context transactions on separate connections, same
      // as WorkspaceGuard/WorkspacesService.switchTo). If this were after
      // the commit and a transient failure hit here, the rotation above
      // would already be durable — the presented refresh token consumed,
      // the new one minted — but the response that hands the new one back
      // would never be sent, stranding the caller with no valid token at
      // all. Inside the transaction, a failure here rolls the WHOLE
      // rotation back too, so the caller's existing (still-unconsumed)
      // refresh token remains good for a retry. The row lock `sessionRow`
      // was read under (`FOR UPDATE` above) also means a concurrent
      // `switchWorkspace` on the SAME session serializes against this
      // rather than racing it.
      const active = await this.reverifyActiveWorkspace(
        client,
        sessionRow.id,
        sessionRow.user_id,
        sessionRow.active_workspace_id,
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
   * that are stale relative to the live database. Returns all-null when
   * there is nothing to re-verify (a pre-onboarding session) OR when
   * re-verification fails — both mint the same ws:null token sign-in already
   * produces, which is the fail-closed contract.
   *
   * On failure, clears `active_workspace_id` back to NULL — guarded by
   * `WHERE active_workspace_id = $2`, the value THIS call observed, so a
   * `switchWorkspace` racing concurrently is never clobbered by a refresh
   * that started before it.
   */
  private async reverifyActiveWorkspace(
    client: ClientBase,
    sid: string,
    userId: string,
    activeWorkspaceId: string | null,
  ): Promise<{ ws: string | null; role: string | null; scope: readonly string[] | null; entV: number | null }> {
    if (activeWorkspaceId === null) {
      return { ws: null, role: null, scope: null, entV: null };
    }

    const workspace = await this.membership.getWorkspaceStatus(this.pool, activeWorkspaceId);
    if (isWorkspaceUsable(workspace)) {
      const live = await this.membership.getLiveMembership(this.pool, userId, activeWorkspaceId);
      if (live && live.status === "active") {
        return { ws: activeWorkspaceId, role: live.role, scope: live.projectScope, entV: workspace.entitlementVersion };
      }
    }

    // On the OUTER transaction's own connection/client — see refresh()'s
    // call site comment for why this runs before that transaction commits.
    // The `AND active_workspace_id = $2` guard is redundant with the row
    // lock `refresh()` already holds (a concurrent switchWorkspace on this
    // session cannot even start until this transaction ends) but costs
    // nothing and keeps the write self-explaining on its own.
    await client.query(`UPDATE sessions SET active_workspace_id = NULL WHERE id = $1 AND active_workspace_id = $2`, [
      sid,
      activeWorkspaceId,
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
      // above (and under the same row lock `refresh`'s own `SELECT ... FOR
      // UPDATE` takes), so a switch and a concurrent refresh of the same
      // session serialize rather than race.
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
