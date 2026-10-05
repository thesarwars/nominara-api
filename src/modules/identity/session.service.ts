import { Inject, Injectable, Logger, UnauthorizedException } from "@nestjs/common";
import type { Pool } from "pg";
import { loadEnv } from "../../config/env.js";
import { PG_POOL } from "../../db/pg-pool.js";
import { importEd25519PrivateKeyFromDer, signAccessToken } from "../../lib/auth/access-token.js";
import { computeCsrfToken } from "../../lib/auth/csrf.js";
import { REFRESH_TOKEN_TTL_MS, generateRefreshToken, hashRefreshToken } from "../../lib/auth/refresh-token.js";
import { uuidV7 } from "../../lib/ids/uuidv7.js";
import type { StrongAuthMethod } from "../../tenancy/constants.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";

// STORY-017 — dangerous area: rotation and reuse-detection logic. Full
// history is checked (each refresh_tokens row is a distinct issued
// instance, never overwritten), not just "the previous token" — so theft
// from two or more rotations back is still caught as reuse. Every mutating
// step runs inside a single BEGIN/COMMIT transaction with `SELECT ... FOR
// UPDATE` on the row being consumed, so a raced double-refresh of the same
// token can never both succeed. A workspace switch never reads `ws` from
// client-supplied input — the new access token always mints ws/role/scope/
// ent_v fresh from server-side state the caller passed in explicitly.

export interface SessionTokens {
  readonly sid: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly csrfToken: string;
}

@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

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

  /**
   * New session at authentication time. Workspace context starts empty — a real workspace is only ever entered via switchWorkspace.
   *
   * `strongAuth` (STORY-173) names the ceremony the platform itself just
   * performed to create this session — a WebAuthn assertion or an email
   * one-time code — and stamps `last_strong_auth_at/method` with it, so the
   * session counts as freshly re-authenticated for the step-up window
   * (security-and-tenancy.md §5). Left null for a session that was not
   * created by such a ceremony (OAuth, workspace switch), which then has to
   * step up before anything that demands it.
   */
  async createSession(
    userId: string,
    now: Date = new Date(),
    strongAuth: StrongAuthMethod | null = null,
  ): Promise<SessionTokens> {
    const sid = uuidV7();
    const rawRefreshToken = generateRefreshToken();
    const expiresAt = new Date(now.getTime() + REFRESH_TOKEN_TTL_MS);

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO sessions (id, user_id, last_strong_auth_at, last_strong_auth_method) VALUES ($1, $2, $3, $4)`,
        [sid, userId, strongAuth === null ? null : now, strongAuth],
      );
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

      const sessionResult = await client.query<{ id: string; user_id: string; revoked_at: Date | null }>(
        `SELECT id, user_id, revoked_at FROM sessions WHERE id = $1 FOR UPDATE`,
        [tokenRow.session_id],
      );
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

      await client.query("COMMIT");

      const { accessToken, csrfToken } = await this.mintAccessAndCsrf(sessionRow.id, sessionRow.user_id, now);
      return { sid: sessionRow.id, accessToken, refreshToken: rawNewRefreshToken, csrfToken };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
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
      const result = await client.query<{ revoked_at: Date | null }>(
        `SELECT revoked_at FROM sessions WHERE id = $1 AND user_id = $2`,
        [sid, userId],
      );
      const row = result.rows[0];
      if (!row || row.revoked_at !== null) {
        throw new UnauthorizedException("session revoked");
      }
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
  async recordStrongAuth(sessionId: string, method: StrongAuthMethod, at: Date = new Date()): Promise<void> {
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
