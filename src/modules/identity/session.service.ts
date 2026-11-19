import { Inject, Injectable, Logger, UnauthorizedException } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { ClientBase, Pool } from "pg";
import { loadEnv } from "../../config/env.js";
import { NotFoundError } from "../../api/errors/domain-errors.js";
import { decodeCursor } from "../../api/pagination/cursor.js";
import { pageFrom, type Page } from "../../api/pagination/page.js";
import type { PaginationRequest } from "../../../contracts/common/pagination.schema.js";
import type { SessionListItem } from "../../../contracts/identity/session-list-response.schema.js";
import { PG_POOL } from "../../db/pg-pool.js";
import { withTenantContext } from "../../tenancy/tenant-context.js";
import { AuditChainService } from "../audit/audit-chain.service.js";
import { importEd25519PrivateKeyFromDer, signAccessToken } from "../../lib/auth/access-token.js";
import { computeCsrfToken } from "../../lib/auth/csrf.js";
import { describeUserAgent, normalizeUserAgent } from "../../lib/auth/user-agent.js";
import {
  REFRESH_TOKEN_GRACE_CACHE_COOLOFF_MS,
  REFRESH_TOKEN_GRACE_CACHE_DEADLINE_MS,
  REFRESH_TOKEN_TTL_MS,
  decryptGraceSuccessor,
  encryptGraceSuccessor,
  generateRefreshToken,
  graceHardBoundMs,
  hashRefreshToken,
  parseGraceSlot,
  serializeGraceSlot,
} from "../../lib/auth/refresh-token.js";
import { CACHE, type Cache } from "../../lib/cache/cache.port.js";
import { cacheKeyNamespace } from "../../lib/cache/key-namespace.js";
import { refreshGraceSlotKey } from "../../lib/cache/valkey-keys.js";
import { uuidV7 } from "../../lib/ids/uuidv7.js";
import type { StrongAuthMethod } from "../../tenancy/constants.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { isWorkspaceUsable, MembershipService } from "../workspaces/membership.service.js";

const tracer = trace.getTracer("nominara.identity");

// Batch 19 (owner decision 108(a)) - the two refresh-token security events are audit rows, not only a log line and a counter.
const auditChain = new AuditChainService();

interface PendingSecurityAudit {
  readonly action: "session.reuse_detected" | "session.refresh_grace_reuse";
  readonly severity: "critical" | "notice";
  readonly sessionId: string;
  readonly userId: string;
  /** The workspace whose chain the row goes into; null when the session has none that still verifies, in which case NO row is written. */
  readonly workspaceId: string | null;
  readonly afterState: Record<string, string>;
  /**
   * Set for an event that must be written once per rotation (the grace-window reuse: every racing or retrying caller inside one window hits the
   * same branch, and each would otherwise add a row). The id of the consumed refresh-token row, which is the rotation; it is stored in after_state as
   * `rotation_id` (not a secret: a row id, never the token or its hash) and is what the lookup keys on.
   */
  readonly oncePerRotation?: string;
}

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

// STORY-170 — the refresh-token reuse GRACE WINDOW (security-and-tenancy.md
// §5 "Session model"). The slot naming the session's most recent rotation
// lives in the shared cache (Valkey), NOT in Postgres, and this is the whole
// design rather than a detail of it:
//
// - It carries a TTL equal to the window, so it ceases to exist when the
//   window closes. A database column would outlive the window for as long as
//   the session sat idle, and "a database read plus an old, already-consumed
//   token" would open the live successor offline — a consumed token would no
//   longer be worthless.
// - It is written as the LAST step of the rotation, inside the transaction,
//   immediately before COMMIT. That anchors the window at the commit on the
//   cache's own clock — not on the `now` captured when the request arrived
//   (before membership reads, pool.connect and FOR UPDATE waits, on one
//   instance's own clock) — and it means a racer blocked on the token row's
//   FOR UPDATE reads the slot right after the commit that released it.
// - The cache is never trusted to be there. If a write, a read or a delete
//   fails, or does not answer inside REFRESH_TOKEN_GRACE_CACHE_DEADLINE_MS,
//   the rotation still succeeds (a cache outage must never fail a normal
//   refresh) but leaves no slot, and a replay then revokes exactly as the
//   strict rule says. Fail closed.
// - ...and it is never trusted to be PROMPT. A write that missed its deadline
//   is not cancelled: Valkey executes it when it recovers, with a full TTL
//   from then. So the slot is not the only bound — the presented
//   predecessor's `consumed_at`, stamped by the rotation with Postgres's
//   `clock_timestamp()`, must also be younger than the window plus the cache
//   deadline (`graceHardBoundMs`). A slot that lands late is inert.
// - A cache that is quiet costs a deadline per rotation, held on a pool
//   connection and row locks, until the circuit breaker below opens: after one
//   miss or error the cache is skipped altogether for a cool-off (per
//   process), so a replay revokes and a rotation costs what it would with no
//   grace window at all.
// - A slot is honoured only while EVERY condition holds (see
//   `readGraceSuccessor`); one of them is that the successor it names is
//   still a live refresh token of this session, so a slot that was not
//   rewritten by some later rotation can never hand out a dead token.

// What `viaGraceCache` returns instead of a cache result when the breaker is open.
const CACHE_SKIPPED = Symbol("grace-cache-skipped");

export interface SessionTokens {
  readonly sid: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly csrfToken: string;
}

@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  // The grace cache's circuit breaker, per process. `performance.now()` (not
  // the wall clock) so a clock step cannot shorten or stretch the cool-off.
  // 0 means closed: the cache is in use. Otherwise the cache is skipped until
  // this instant; once it has passed, ONE call (the probe) is let through and
  // only its outcome closes the breaker or restarts the cool-off.
  private graceCacheOpenUntilMs = 0;
  private graceCacheProbing = false;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly membership: MembershipService,
    @Inject(CACHE) private readonly cache: Cache,
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
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const tokens = await this.createSessionOn(client, userId, now, strongAuth);
      await client.query("COMMIT");
      return tokens;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * STORY-173 — the same session, inserted on the CALLER'S client inside the
   * CALLER'S transaction (no BEGIN/COMMIT here). A sign-in that decides who the
   * user is, under a lock on that user, must mint the session in that same
   * transaction: minted afterwards, there is a gap in which the first proof of
   * the address can revoke the account's sessions and miss this one. The
   * tokens are signed after the inserts and only mean anything if the caller
   * commits.
   */
  async createSessionOn(
    client: { query: Pool["query"] },
    userId: string,
    now: Date = new Date(),
    strongAuth: StrongAuthMethod | null = null,
  ): Promise<SessionTokens> {
    const sid = uuidV7();
    const rawRefreshToken = generateRefreshToken();
    const expiresAt = new Date(now.getTime() + REFRESH_TOKEN_TTL_MS);

    await client.query(
      `INSERT INTO sessions (id, user_id, last_strong_auth_at, last_strong_auth_method) VALUES ($1, $2, $3, $4)`,
      [sid, userId, strongAuth === null ? null : now, strongAuth],
    );
    await client.query(
      `INSERT INTO refresh_tokens (id, session_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)`,
      [uuidV7(), sid, hashRefreshToken(rawRefreshToken), expiresAt],
    );

    const { accessToken, csrfToken } = await this.mintAccessAndCsrf(sid, userId, now);
    return { sid, accessToken, refreshToken: rawRefreshToken, csrfToken };
  }

  /**
   * Rotates the presented refresh token. Presenting an already-consumed
   * token revokes the entire session family and raises a security event —
   * UNLESS it is the token consumed by this session's own
   * immediately-preceding rotation and still inside its grace window
   * (STORY-170), in which case the same successor is returned instead.
   */
  async refresh(rawRefreshToken: string, now: Date = new Date()): Promise<SessionTokens> {
    const tokenHash = hashRefreshToken(rawRefreshToken);
    const env = loadEnv();

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

    let revokedSessionId: string | null = null;
    // Batch 19 - written AFTER the rotation's connection is released (see the header: never a second connection from this pool while one is held).
    let pendingAudit: PendingSecurityAudit | null = null;
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
        // STORY-170 — the refresh-token reuse GRACE WINDOW. The session row
        // is locked FOR UPDATE — the SAME lock, taken in the SAME order
        // (token row, then session row), the normal rotation branch below
        // takes — before anything is decided, so a rotation that is still
        // committing has finished by the time the slot is read.
        const graceSessionResult = await client.query<{
          id: string;
          user_id: string;
          revoked_at: Date | null;
          active_workspace_id: string | null;
        }>(`SELECT id, user_id, revoked_at, active_workspace_id FROM sessions WHERE id = $1 FOR UPDATE`, [
          tokenRow.session_id,
        ]);
        const graceSession = graceSessionResult.rows[0];

        // Eligible only for the IMMEDIATE predecessor of a LIVE (non-revoked)
        // family whose slot still exists, and only while the successor it
        // names is itself still live — see `readGraceSuccessor`. A revoked
        // session (a logout inside the window, an earlier reuse revocation)
        // never reads the slot at all. Anything else — an older token, a
        // different session, an already-dead family, a window that has
        // closed (the slot is simply gone), an unreachable cache — falls
        // through to the unchanged revoke-and-raise path below.
        const successorRaw =
          graceSession !== undefined && graceSession.revoked_at === null
            ? await this.readGraceSuccessor(
                client,
                graceSession.id,
                tokenHash,
                rawRefreshToken,
                env.REFRESH_TOKEN_GRACE_WINDOW_MS,
                now,
              )
            : null;

        if (graceSession !== undefined && successorRaw !== null) {
          // The slot itself is left untouched (NOT deleted, NOT re-dated) —
          // a second, third, ... racing caller inside the same window must
          // keep hitting this same branch and keep getting the same
          // successor back. It is replaced by the next real rotation and
          // expires with the window either way.
          await client.query(`UPDATE sessions SET last_used_at = now() WHERE id = $1`, [graceSession.id]);

          // STORY-170 — "the workspace re-verification STORY-170 added
          // still runs": a grace hit re-mints from the SAME
          // preRead/preVerified this call already computed above (BEFORE
          // BEGIN, exactly like the normal rotation branch), never from
          // whatever ws/role/scope the original rotation minted — time has
          // passed, and membership/role/plan may have changed inside the
          // window.
          const active = await this.finalizeWorkspaceContext(
            client,
            graceSession.id,
            graceSession.active_workspace_id,
            preActiveWorkspaceId,
            preVerified,
          );

          await client.query("COMMIT");

          // Audited security event, distinct from session.reuse_detected —
          // the session id only, never a token (NFR-SEC-11).
          this.logger.warn(
            `session.refresh_grace_reuse — refresh token grace-window reuse, same successor returned session_id=${graceSession.id}`,
          );
          incrementCounter("nominara_identity_session_refresh_grace_reuse_total", { session_id: graceSession.id });
          pendingAudit = {
            action: "session.refresh_grace_reuse",
            severity: "notice",
            sessionId: graceSession.id,
            userId: graceSession.user_id,
            workspaceId: active.ws,
            afterState: { outcome: "same_successor_returned", session_owner_user_id: graceSession.user_id, rotation_id: tokenRow.id },
            oncePerRotation: tokenRow.id,
          };

          const { accessToken, csrfToken } = await this.mintAccessAndCsrf(
            graceSession.id,
            graceSession.user_id,
            now,
            active.ws,
            active.role,
            active.scope,
            active.entV,
          );
          return { sid: graceSession.id, accessToken, refreshToken: successorRaw, csrfToken };
        }

        // Not grace-eligible: unchanged from pre-grace-window behaviour —
        // revoke the whole family and raise session.reuse_detected.
        const revocation = await client.query(
          `UPDATE sessions SET revoked_at = now(), revoked_reason = 'reuse_detected' WHERE id = $1 AND revoked_at IS NULL`,
          [tokenRow.session_id],
        );
        await client.query("COMMIT");
        // One row per family revoked: a replay of an already-revoked family changes nothing and adds nothing, so a holder of an old token cannot
        // make the workspace's chain grow by presenting it again. The workspace is the session's own, and only while it still verifies for this
        // user (the pre-read above): a former member's stale session writes nothing into a chain it no longer belongs to.
        if (graceSession !== undefined && (revocation.rowCount ?? 0) > 0) {
          pendingAudit = {
            action: "session.reuse_detected",
            severity: "critical",
            sessionId: tokenRow.session_id,
            userId: graceSession.user_id,
            workspaceId:
              graceSession.active_workspace_id !== null &&
              graceSession.active_workspace_id === preActiveWorkspaceId &&
              preVerified !== null
                ? graceSession.active_workspace_id
                : null,
            afterState: { revoked_reason: "reuse_detected", session_owner_user_id: graceSession.user_id },
          };
        }
        this.logger.warn(`refresh token reuse detected — session family revoked session_id=${tokenRow.session_id}`);
        incrementCounter("nominara_identity_session_reuse_detected_total", { session_id: tokenRow.session_id });
        // Flagged for the `finally` below, which removes the slot AFTER the
        // connection is released: the family is already revoked (which is
        // what makes the slot inert), so the removal only stops a dead
        // session leaving a sealed successor in the cache for the rest of its
        // TTL, and must not pin a pool connection while it waits on the cache.
        revokedSessionId = tokenRow.session_id;
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

      // `clock_timestamp()`, not `now()`: `now()` is the transaction's START,
      // which precedes every lock wait above, so a rotation that queued for a
      // second would be stamped a second too early. The hard bound in
      // `readGraceSuccessor` reads this stamp.
      await client.query(`UPDATE refresh_tokens SET consumed_at = clock_timestamp() WHERE id = $1`, [tokenRow.id]);

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

      // STORY-170 — the grace slot, and it is deliberately the LAST thing
      // this transaction does. This rotation's own token (the one just
      // presented, `tokenHash`) becomes the ONE grace-eligible predecessor of
      // this session, replacing whatever the previous rotation left. Written
      // here, with a TTL equal to the window, the window is anchored at the
      // commit on the cache's clock, and a racer blocked on this token row's
      // FOR UPDATE reads the slot the instant the commit below releases it.
      // Never throws: a cache that cannot take the slot costs the window,
      // not the rotation.
      await this.writeGraceSlot(
        sessionRow.id,
        tokenHash,
        rawRefreshToken,
        rawNewRefreshToken,
        env.REFRESH_TOKEN_GRACE_WINDOW_MS,
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
      // Never throws (see discardGraceSlot), so it cannot replace the
      // UnauthorizedException that is already on its way out.
      if (revokedSessionId !== null) await this.discardGraceSlot(revokedSessionId);
      // Never throws either (see auditSecurityEvent).
      if (pendingAudit !== null) await this.auditSecurityEvent(pendingAudit);
    }
  }

  /**
   * Batch 19 (decision 108(a)) - the audit row for a session security event, on its own tenant-context transaction.
   *
   * NO WORKSPACE, NO ROW. `audit_log` is per-workspace and a session may have none (it signed in and never switched, or its workspace no longer
   * verifies); inventing one would write into a chain the session has no business in. That outcome is counted, not silent, and the log line and
   * the original metric still exist.
   *
   * NEVER THROWS. The rotation has already committed: a failed audit write must not turn a legitimate grace-window refresh into a failure, and
   * must not replace the 401 a reuse is already on its way out with. It is NOT silent: an error log line carrying the session id and error class
   * only, and a counter to alert on.
   */
  private async auditSecurityEvent(event: PendingSecurityAudit): Promise<void> {
    if (event.workspaceId === null) {
      incrementCounter("nominara_identity_session_security_event_unaudited_total", { event: event.action, reason: "no_verified_workspace" });
      return;
    }
    const workspaceId = event.workspaceId;
    await tracer.startActiveSpan("identity.session.security_audit", async (span) => {
      span.setAttribute("nominara.audit.action", event.action);
      span.setAttribute("nominara.workspace_id", workspaceId);
      try {
        const client = await this.pool.connect();
        try {
          // The tenant context's actor GUC is transient session state, not part of the row; the ROW names no actor (below).
          const written = await withTenantContext(client, { workspaceId, actorId: event.userId }, async (tx) => {
            if (event.oncePerRotation !== undefined) {
              // Serialise on the rotation, THEN look: two hits racing on one window would otherwise both find nothing and both write. Taken before
              // the chain's own lock (append) and by nothing else, so the order cannot deadlock.
              await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${event.action}:${event.oncePerRotation}`]);
              const existing = await tx.query(
                `SELECT 1 FROM audit_log WHERE workspace_id = $1 AND action = $2 AND resource_id = $3 AND after_state->>'rotation_id' = $4 LIMIT 1`,
                [workspaceId, event.action, event.sessionId, event.oncePerRotation],
              );
              if ((existing.rowCount ?? existing.rows.length) > 0) return false;
            }
            await auditChain.append(tx, {
              workspaceId,
              // NOT "user". The session's owner is the VICTIM of a reuse (or the legitimate refresher of a grace hit), and the party presenting
              // the consumed token is unknown: attributing the act to the owner would put the attacker's request on the victim's record. The
              // system detected it; the owner is named as the subject, in after_state, and the session is the resource.
              actorType: "system",
              actorId: null,
              actorIp: null,
              actorUa: null,
              action: event.action,
              resourceType: "session",
              resourceId: event.sessionId,
              beforeState: null,
              afterState: event.afterState,
              requestId: `auth.refresh:${uuidV7()}`,
              supportGrantId: null,
              severity: event.severity,
            });
            return true;
          });
          if (!written) {
            incrementCounter("nominara_identity_session_security_event_deduplicated_total", { event: event.action });
            return;
          }
        } finally {
          client.release();
        }
        incrementCounter("nominara_identity_session_security_event_audited_total", { event: event.action });
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        incrementCounter("nominara_identity_session_security_audit_failures_total", { event: event.action });
        this.logger.error(
          `${event.action} audit row not written session_id=${event.sessionId} workspace_id=${workspaceId} error=${error instanceof Error ? error.name : "unknown"}`,
        );
      } finally {
        span.end();
      }
    });
  }

  /**
   * STORY-170 — the grace slot's write, called as the last step of a
   * rotation, inside its transaction. `windowMs === 0` is the documented way
   * to disable the feature: no slot is written, so the very next reuse of ANY
   * token revokes exactly as before STORY-170.
   *
   * NEVER THROWS. A cache that errors, is unreachable, or does not answer
   * inside the deadline leaves the rotation to commit without a slot; a replay
   * then revokes as the strict rule says. The failure is logged (session id and
   * error class only — an error message can carry a connection URL) and
   * counted, and it opens the circuit breaker (see `viaGraceCache`), so while
   * that is open no slot is attempted at all.
   */
  private async writeGraceSlot(
    sessionId: string,
    predecessorHash: string,
    rawPredecessorToken: string,
    rawSuccessorToken: string,
    windowMs: number,
  ): Promise<void> {
    if (windowMs <= 0) return;
    try {
      const slot = serializeGraceSlot({
        predecessorHash,
        successorCiphertext: encryptGraceSuccessor(sessionId, rawPredecessorToken, rawSuccessorToken),
      });
      await this.viaGraceCache("write", () =>
        this.cache.set(refreshGraceSlotKey(cacheKeyNamespace(), sessionId), slot, { ttlMs: windowMs }),
      );
    } catch (error) {
      this.reportGraceCacheFailure("write", sessionId, error);
    }
  }

  /**
   * STORY-170 — the successor a grace-window hit returns, or `null` when the
   * presented token is not entitled to one. Runs on `client`, AFTER the
   * session row is locked, and returns the raw successor only when EVERY
   * condition holds:
   *
   * - the window is enabled (`windowMs > 0` — 0 disables grace outright, even
   *   if a slot written under an earlier setting is still in the cache);
   * - a slot exists — the cache's TTL is the expiry, so a closed window is an
   *   absent key, not a comparison this code could get wrong;
   * - the slot is well-formed and its predecessor hash equals the presented
   *   token's hash — only the IMMEDIATE predecessor, never a token two
   *   rotations back;
   * - the successor opens with a key derived from the token presented (the
   *   only thing that can open it), under this session's id;
   * - the successor is LIVE: an unconsumed, unexpired refresh_tokens row of
   *   THIS session. A slot that some path failed to replace can therefore
   *   never hand a two-back token an already-consumed successor;
   * - the presented token was consumed no longer ago than the window plus the
   *   cache deadline, on Postgres's clock — so a slot that a stalled cache
   *   wrote LATE, with a fresh TTL, opens nothing.
   *
   * A cache error or a missed deadline is "no slot" — fail closed, and never
   * an exception: the caller falls through to the revoke path.
   */
  private async readGraceSuccessor(
    client: ClientBase,
    sessionId: string,
    presentedHash: string,
    rawPresentedToken: string,
    windowMs: number,
    now: Date,
  ): Promise<string | null> {
    if (windowMs <= 0) return null;

    let stored: string | undefined | typeof CACHE_SKIPPED;
    try {
      stored = await this.viaGraceCache("read", () =>
        this.cache.get(refreshGraceSlotKey(cacheKeyNamespace(), sessionId)),
      );
    } catch (error) {
      this.reportGraceCacheFailure("read", sessionId, error);
      return null;
    }
    // Breaker open: the cache was not asked, so there is no slot to honour.
    if (stored === undefined || stored === CACHE_SKIPPED) return null;

    const slot = parseGraceSlot(stored);
    if (slot === undefined || slot.predecessorHash !== presentedHash) return null;

    let successorRaw: string;
    try {
      successorRaw = decryptGraceSuccessor(sessionId, rawPresentedToken, slot.successorCiphertext);
    } catch {
      return null;
    }

    // Two conditions, one statement, evaluated after every cache wait above:
    //  - the successor is LIVE (unconsumed, unexpired, this session's);
    //  - the presented predecessor's own consumption is inside the HARD BOUND
    //    (window + cache deadline) on POSTGRES's clock — the one bound a stalled
    //    cache cannot move (see `graceHardBoundMs`). `clock_timestamp()`, not
    //    `now()`: `now()` would freeze at this transaction's start and hide the
    //    time the cache waits above just took.
    const live = await client.query(
      `SELECT 1 FROM refresh_tokens
        WHERE token_hash = $1 AND session_id = $2 AND consumed_at IS NULL AND expires_at > $3
          AND EXISTS (SELECT 1 FROM refresh_tokens predecessor
                       WHERE predecessor.token_hash = $4 AND predecessor.session_id = $2
                         AND predecessor.consumed_at
                             > clock_timestamp() - ($5::double precision * interval '1 millisecond'))`,
      [hashRefreshToken(successorRaw), sessionId, now, presentedHash, graceHardBoundMs(windowMs)],
    );
    return live.rows.length > 0 ? successorRaw : null;
  }

  /** STORY-170 — best-effort removal of a dead session's slot. Never throws; see the call site. */
  private async discardGraceSlot(sessionId: string): Promise<void> {
    try {
      await this.viaGraceCache("delete", () => this.cache.delete(refreshGraceSlotKey(cacheKeyNamespace(), sessionId)));
    } catch (error) {
      this.reportGraceCacheFailure("delete", sessionId, error);
    }
  }

  /**
   * Every grace-slot cache call goes through here, and it is the circuit
   * breaker's only door. Returns `CACHE_SKIPPED` without calling the cache while
   * the breaker is open; otherwise runs `call` under the deadline. A rejection
   * or a missed deadline OPENS the breaker (for
   * REFRESH_TOKEN_GRACE_CACHE_COOLOFF_MS) and is rethrown for the caller to
   * report; when the cool-off has passed, the first caller is the probe — the
   * rest keep skipping until it settles — and only the probe's success closes
   * the breaker (a slow answer to a call that started before it opened proves
   * nothing about now).
   *
   * Without it a silent cache costs the deadline on EVERY rotation, each held
   * on a pool connection and row locks: measured, 40 concurrent refreshes on a
   * 10-connection pool blocked an unrelated `SELECT 1` for ~2s. With it the
   * cost is one deadline per cool-off, plus whatever was already in flight
   * when it opened.
   */
  private async viaGraceCache<T>(
    operation: "write" | "read" | "delete",
    call: () => Promise<T>,
  ): Promise<T | typeof CACHE_SKIPPED> {
    const admission = this.admitGraceCache();
    if (admission === "skip") {
      incrementCounter("nominara_identity_session_refresh_grace_cache_skipped_total", { operation });
      return CACHE_SKIPPED;
    }
    try {
      const result = await this.withinCacheDeadline(call());
      if (admission === "probe") this.closeGraceCache();
      return result;
    } catch (error) {
      this.openGraceCache(admission === "probe");
      throw error;
    } finally {
      if (admission === "probe") this.graceCacheProbing = false;
    }
  }

  private admitGraceCache(): "use" | "probe" | "skip" {
    if (this.graceCacheOpenUntilMs === 0) return "use";
    if (this.graceCacheProbing || performance.now() < this.graceCacheOpenUntilMs) return "skip";
    this.graceCacheProbing = true;
    return "probe";
  }

  private openGraceCache(wasProbe: boolean): void {
    const wasClosed = this.graceCacheOpenUntilMs === 0;
    this.graceCacheOpenUntilMs = performance.now() + REFRESH_TOKEN_GRACE_CACHE_COOLOFF_MS;
    // One line per transition — a burst of calls that were already in flight
    // when it opened must not write one each.
    if (wasClosed || wasProbe) {
      this.logger.warn(
        `refresh grace cache circuit open — no grace slot is written or read for ${String(REFRESH_TOKEN_GRACE_CACHE_COOLOFF_MS)}ms, so a replay revokes`,
      );
    }
  }

  private closeGraceCache(): void {
    this.graceCacheOpenUntilMs = 0;
    this.logger.log("refresh grace cache circuit closed — the cache answered its probe, grace slots resume");
  }

  /**
   * Rejects when `operation` has not settled inside
   * REFRESH_TOKEN_GRACE_CACHE_DEADLINE_MS. The grace slot is touched while the
   * rotation transaction holds row locks and a pool connection, so this bounds
   * ONE wait: a cache that accepts the connection and then goes quiet still
   * costs each caller up to the deadline holding both. What stops that
   * repeating is the circuit breaker in `viaGraceCache`. (A late settlement of
   * the abandoned call is handled by the race, so it cannot surface as an
   * unhandled rejection — but the abandoned call is NOT cancelled, and a write
   * may still land later; the hard bound in `readGraceSuccessor` is what makes
   * that harmless.)
   */
  private async withinCacheDeadline<T>(operation: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error("cache deadline exceeded"));
      }, REFRESH_TOKEN_GRACE_CACHE_DEADLINE_MS);
    });
    try {
      return await Promise.race([operation, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  private reportGraceCacheFailure(operation: "write" | "read" | "delete", sessionId: string, error: unknown): void {
    // The error CLASS only. A connection error's message can carry the cache
    // URL, and the URL can carry credentials.
    const errorClass = error instanceof Error ? error.name : "unknown";
    const consequence = {
      write: "this rotation leaves no grace slot, so a replay will revoke",
      read: "this replay gets no grace and revokes",
      delete: "the dead session's slot is left to expire with its TTL",
    }[operation];
    this.logger.warn(`refresh grace slot ${operation} failed — ${consequence} session_id=${sessionId} error=${errorClass}`);
    incrementCounter("nominara_identity_session_refresh_grace_cache_failure_total", { operation });
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
  async recordStrongAuth(sessionId: string, method: StrongAuthMethod, at: Date = new Date()): Promise<void> {
    await this.pool.query("UPDATE sessions SET last_strong_auth_at = $2, last_strong_auth_method = $3 WHERE id = $1", [
      sessionId,
      at,
      method,
    ]);
  }

  /**
   * STORY-021 / EC-15 — ownership transfer: every live session of the named users is revoked ("add every session of
   * the outgoing owner to the revocation list"; the decision extends it to the incoming owner). Runs on the CALLER's
   * client so it commits with the role swap — there is no window in which the roles have changed and the departed
   * owner's sessions are still valid. `sessions` is global (no RLS); the statement is bounded by `user_id`.
   * `revoked_reason` is left NULL: the closed reason list is not widened for this slice, the audit row says why.
   */
  async revokeAllForUsers(client: ClientBase, userIds: readonly string[], exceptSessionId?: string): Promise<number> {
    // STORY-018 — `exceptSessionId` keeps the session that is making the call: a credential change or "sign out other
    // sessions" ends every OTHER session of the account, never the one the person is using. Absent, nothing is kept.
    const result = await client.query(
      `UPDATE sessions SET revoked_at = now()
        WHERE user_id = ANY($1::uuid[]) AND revoked_at IS NULL AND ($2::uuid IS NULL OR id <> $2::uuid)`,
      [userIds, exceptSessionId ?? null],
    );
    return result.rowCount ?? 0;
  }

  /**
   * STORY-096 AC4/AC7 — remember the device's User-Agent on the session (sign-in and refresh). Cosmetic and best-effort: it is never read for an
   * access decision, so a failure here must not fail a sign-in that already succeeded. An absent or empty header leaves the stored value as it was.
   * The header is a fingerprint: it is stored and shown parsed, and never logged (the error path logs the session ID and the error class only).
   */
  async recordUserAgent(sid: string, rawUserAgent: string | readonly string[] | undefined): Promise<void> {
    const userAgent = normalizeUserAgent(rawUserAgent);
    if (userAgent === null) return;
    try {
      await this.pool.query(`UPDATE sessions SET user_agent = $2 WHERE id = $1`, [sid, userAgent]);
    } catch (error) {
      this.logger.warn(`session user agent not recorded session_id=${sid} error=${error instanceof Error ? error.name : "unknown"}`);
    }
  }

  /**
   * STORY-096 AC4 — the caller's OWN live sessions, newest first. `sessions` is a global auth-only table with no RLS, so `user_id = $1` (the verified
   * token's `sub`, never a request value) is the control. Live means not revoked AND still holding an unexpired, unconsumed refresh token: a session whose
   * token ran out cannot be used and is not shown. Only the parsed device and browser leave the server, never the stored header.
   */
  async listForUser(userId: string, currentSessionId: string, pagination: PaginationRequest): Promise<Page<SessionListItem>> {
    return tracer.startActiveSpan("identity.sessions.list", async (span) => {
      try {
        span.setAttribute("nominara.user_id", userId);
        const after = pagination.cursor === undefined ? undefined : decodeCursor(pagination.cursor, "identity.sessions", 2);
        const result = await this.pool.query<{
          id: string;
          user_agent: string | null;
          created_at: Date;
          last_used_at: Date;
          created_at_key: string;
        }>(
          `SELECT s.id, s.user_agent, s.created_at, s.last_used_at, s.created_at::text AS created_at_key
             FROM sessions s
            WHERE s.user_id = $1 AND s.revoked_at IS NULL
              AND EXISTS (SELECT 1 FROM refresh_tokens rt
                           WHERE rt.session_id = s.id AND rt.consumed_at IS NULL AND rt.expires_at > now())
              AND ($2::timestamptz IS NULL OR (s.created_at, s.id) < ($2::timestamptz, $3::uuid))
            ORDER BY s.created_at DESC, s.id DESC
            LIMIT $4`,
          [userId, after?.[0] ?? null, after?.[1] ?? null, pagination.limit + 1],
        );
        span.setAttribute("nominara.sessions.listed", Math.min(result.rows.length, pagination.limit));
        return pageFrom(
          result.rows,
          pagination.limit,
          "identity.sessions",
          (row): SessionListItem => ({
            id: row.id,
            ...describeUserAgent(row.user_agent),
            created_at: row.created_at.toISOString(),
            last_active_at: row.last_used_at.toISOString(),
            current: row.id === currentSessionId,
          }),
          (row) => [row.created_at_key, row.id],
        );
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  /**
   * STORY-096 AC7 — end ONE of the caller's own sessions. The row is selected by `id` AND `user_id`; a session id is never enough on its own, so another
   * account's session and an unknown id are the same 404 and nothing about the other account is revealed. Revoking a session already ended is a no-op
   * that keeps its first reason (idempotent, like revoke-others). The caller's own current session may be revoked: it is then signed out exactly as by
   * logout, and its cookies are refused on the next request. `revoked_reason` is `user_revoked`, distinct from `logout`.
   */
  async revokeOne(userId: string, sessionId: string, currentSessionId: string): Promise<void> {
    return tracer.startActiveSpan("identity.sessions.revoke_one", async (span) => {
      try {
        span.setAttribute("nominara.user_id", userId);
        span.setAttribute("nominara.sessions.current", sessionId === currentSessionId);
        const revoked = await this.pool.query(
          `UPDATE sessions SET revoked_at = now(), revoked_reason = 'user_revoked'
            WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
          [sessionId, userId],
        );
        if ((revoked.rowCount ?? 0) === 0) {
          const owned = await this.pool.query(`SELECT 1 FROM sessions WHERE id = $1 AND user_id = $2`, [sessionId, userId]);
          if ((owned.rowCount ?? 0) === 0) throw new NotFoundError({ message: "no such session" });
          return;
        }
        this.logger.log(`session revoked by its owner user_id=${userId} session_id=${sessionId} current=${String(sessionId === currentSessionId)}`);
        incrementCounter("nominara_identity_sessions_revoked_total", { reason: "session_revoke" });
      } catch (error) {
        if (!(error instanceof NotFoundError)) span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
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
