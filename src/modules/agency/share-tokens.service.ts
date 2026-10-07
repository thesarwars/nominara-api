import { createHash, randomBytes } from "node:crypto";
import { Injectable, Logger } from "@nestjs/common";
import type { ClientBase, Pool } from "pg";
import type { MintedShareToken, MintShareTokenRequest, ShareToken, ShareTokenView } from "../../../contracts/agency/index.js";
import { EntitlementExceededError, NotFoundError, ProjectOutOfScopeError, ValidationFailedError } from "../../api/errors/domain-errors.js";
import { resolveEntitlements } from "../../lib/entitlements/resolution.js";
import { hash as argon2idHash } from "../../lib/crypto/argon2id.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { currentTenantStore } from "../../tenancy/tenant-context.js";
import { AuditChainService } from "../audit/audit-chain.service.js";

/** integrations-and-sharing.md §3: the canonical fallback host; a custom domain is week 2 (FR-AGY-01d). */
const PORTAL_BASE_URL = "https://portal.nominara.com";
const ENTITLEMENT_KEY = "share_links.enabled";
const SECRET_BYTES = 32;
const PREFIX_LENGTH = 8;
const VIEWS_PAGE_LIMIT = 500;

/** The request facts the notice-severity audit row needs; the interceptor reads the same fields for its own row. */
export interface AuditRequestMeta {
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly requestId: string;
}

/** 32 bytes of CSPRNG as base64url: 43 characters, no padding (FR-AGY-01k). */
export function generateShareSecret(): string {
  return randomBytes(SECRET_BYTES).toString("base64url");
}

/** The only secret-derived value persisted besides the 8-character prefix. */
export function hashShareSecret(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}

/**
 * The active-link ceiling `share_links.enabled` expresses: `"10_active"` -> 10,
 * `"unlimited"` or `true` -> none. Anything unrecognised fails closed at 0.
 */
export function activeLinkLimit(value: unknown): number | null {
  if (value === true || value === "unlimited") return null;
  if (typeof value === "number") return Math.max(0, Math.trunc(value));
  if (typeof value === "string") {
    const m = /^(\d+)_active$/.exec(value);
    if (m !== null) return Number(m[1]);
  }
  return 0;
}

/** integrations-and-sharing.md §3 step 2: 5 wrong passwords per token lock it for 15 minutes. */
export const PASSWORD_FAILURE_LIMIT = 5;
export const PASSWORD_LOCK_MS = 15 * 60 * 1000;

/** What the portal gate is allowed to know about a token before it has authenticated anyone. */
export interface GateRow {
  readonly id: string;
  readonly workspaceId: string;
  readonly passwordHash: string | null;
  readonly passwordRequired: boolean;
  readonly scopeProjectIds: readonly string[];
  readonly scopeTabs: readonly string[];
  readonly themeId: string | null;
  readonly allowedEmailDomains: readonly string[];
  readonly revokedAt: Date | null;
  readonly expiresAt: Date | null;
  readonly maxViews: number | null;
  readonly viewCount: number;
  readonly lockedUntil: Date | null;
}

/** FR-AGY-01m/n: revoked, expired and view-capped are ONE refusal to the caller; the reason is for our metric only. */
export type GateRefusal = "revoked" | "expired" | "view_cap";

export function gateRefusal(row: Pick<GateRow, "revokedAt" | "expiresAt" | "maxViews" | "viewCount">, now: Date): GateRefusal | null {
  if (row.revokedAt !== null) return "revoked";
  if (row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime()) return "expired";
  if (row.maxViews !== null && row.viewCount >= row.maxViews) return "view_cap";
  return null;
}

interface GateDbRow {
  id: string;
  workspace_id: string;
  password_hash: string | null;
  password_required: boolean;
  scope_project_ids: string[];
  scope_tabs: string[];
  theme_id: string | null;
  allowed_email_domains: string[];
  revoked_at: Date | null;
  expires_at: Date | null;
  max_views: number | null;
  view_count: number;
  locked_until: Date | null;
}

function toGateRow(r: GateDbRow): GateRow {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    passwordHash: r.password_hash,
    passwordRequired: r.password_required,
    scopeProjectIds: r.scope_project_ids,
    scopeTabs: r.scope_tabs,
    themeId: r.theme_id,
    allowedEmailDomains: r.allowed_email_domains,
    revokedAt: r.revoked_at,
    expiresAt: r.expires_at,
    maxViews: r.max_views,
    viewCount: r.view_count,
    lockedUntil: r.locked_until,
  };
}

export interface ViewFacts {
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly authenticated: boolean;
}

interface TokenRow {
  readonly id: string;
  readonly label: string;
  readonly token_prefix: string;
  readonly scope_project_ids: string[];
  readonly scope_tabs: string[];
  readonly hide_competitors: boolean;
  readonly hide_costs: boolean;
  readonly timeframe_lock: string | null;
  readonly theme_id: string | null;
  readonly password_required: boolean;
  readonly allowed_email_domains: string[];
  readonly max_views: number | null;
  readonly view_count: number;
  readonly expires_at: Date | null;
  readonly revoked_at: Date | null;
  readonly created_at: Date;
  readonly last_viewed_at: Date | null;
}

// Never selects token_hash or password_hash: no read path can return them.
const COLUMNS = `id, label, token_prefix, scope_project_ids, scope_tabs, hide_competitors, hide_costs, timeframe_lock,
  theme_id, password_required, COALESCE(allowed_email_domains::text[], '{}') AS allowed_email_domains, max_views,
  view_count, expires_at, revoked_at, created_at, last_viewed_at`;

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

function toShareToken(row: TokenRow): ShareToken {
  return {
    id: row.id,
    label: row.label,
    token_prefix: row.token_prefix,
    scope_project_ids: row.scope_project_ids,
    scope_tabs: row.scope_tabs as ShareToken["scope_tabs"],
    hide_competitors: row.hide_competitors,
    hide_costs: row.hide_costs,
    timeframe_lock: row.timeframe_lock as ShareToken["timeframe_lock"],
    theme_id: row.theme_id,
    password_required: row.password_required,
    allowed_email_domains: row.allowed_email_domains,
    max_views: row.max_views,
    view_count: row.view_count,
    expires_at: iso(row.expires_at),
    revoked_at: iso(row.revoked_at),
    created_at: row.created_at.toISOString(),
    last_viewed_at: iso(row.last_viewed_at),
  };
}

// STORY-098 part A (NEW-E-098a) — owns `share_tokens` and reads
// `share_token_views` (agency side; the portal's session mint is NEW-E-099).
// Every statement runs on the request's context-carrying transaction, so RLS
// (`ws_isolation_share_tokens`) scopes the workspace: a token of another
// workspace is simply absent, which is a 404 and never a 403 (ISO-09).
//
// A project-scoped member (manager with `project_scope`) is narrowed in the
// service, because RLS scopes by workspace only: they may mint for, see, and
// revoke tokens whose whole scope lies inside theirs.
@Injectable()
export class ShareTokensService {
  private readonly logger = new Logger(ShareTokensService.name);

  constructor(private readonly audit: AuditChainService) {}

  async list(): Promise<ShareToken[]> {
    const { client, actorScope } = this.store();
    const result =
      actorScope === null
        ? await client.query<TokenRow>(`SELECT ${COLUMNS} FROM share_tokens ORDER BY created_at DESC, id`)
        : await client.query<TokenRow>(`SELECT ${COLUMNS} FROM share_tokens WHERE scope_project_ids <@ $1::uuid[] ORDER BY created_at DESC, id`, [actorScope]);
    return result.rows.map(toShareToken);
  }

  async mint(body: MintShareTokenRequest, meta: AuditRequestMeta): Promise<MintedShareToken> {
    const { client, workspaceId, actorId, actorScope } = this.store();
    const projectIds = [...new Set(body.scope_project_ids)];

    // Narrowest check first: a scoped member naming a project outside their scope is refused by name (403).
    if (actorScope !== null && projectIds.some((id) => !actorScope.includes(id))) {
      throw new ProjectOutOfScopeError();
    }
    await this.assertProjectsReadable(client, projectIds);
    if (body.theme_id !== undefined && body.theme_id !== null) await this.assertThemeInWorkspace(client, body.theme_id);

    await this.assertWithinActiveLimit(client, workspaceId);

    const secret = generateShareSecret();
    const passwordHash = body.password === null ? null : await argon2idHash(body.password);
    const domains = [...new Set(body.allowed_email_domains.map((d) => d.trim().toLowerCase()))];

    const inserted = await client.query<TokenRow>(
      `INSERT INTO share_tokens (workspace_id, label, token_hash, token_prefix, password_hash, password_required, scope_project_ids,
                                 scope_tabs, hide_competitors, hide_costs, timeframe_lock, theme_id, allowed_email_domains,
                                 max_views, expires_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7::uuid[],$8::text[],$9,$10,$11,$12,$13::citext[],$14,$15,$16)
       RETURNING ${COLUMNS}`,
      [
        workspaceId,
        body.label,
        hashShareSecret(secret),
        secret.slice(0, PREFIX_LENGTH),
        passwordHash,
        body.password !== null,
        projectIds,
        body.scope_tabs,
        body.hide_competitors,
        body.hide_costs,
        body.timeframe_lock,
        body.theme_id ?? null,
        domains,
        body.max_views,
        body.expires_at,
        actorId,
      ],
    );
    const row = inserted.rows[0]!;

    // FR-AGY-01l: a passwordless link is on the record at `notice`. Same
    // transaction as the insert, so neither can exist without the other. The
    // interceptor adds the ordinary `info` row for every mint.
    if (body.password === null) {
      await this.audit.append(client, {
        workspaceId,
        actorType: "user",
        actorId,
        actorIp: meta.ip,
        actorUa: meta.userAgent,
        action: "share_token.minted_without_password",
        resourceType: "share_token",
        resourceId: row.id,
        beforeState: null,
        afterState: { acknowledge_no_password: true, scope_project_count: projectIds.length },
        requestId: meta.requestId,
        supportGrantId: null,
        severity: "notice",
      });
    }

    incrementCounter("nominara_share_token_mints_total", { password: body.password === null ? "none" : "required" });
    this.logger.log(`share token minted workspace_id=${workspaceId} share_token_id=${row.id} password_required=${String(row.password_required)}`);
    return { token: toShareToken(row), secret, url: new URL(`/r/${secret}`, PORTAL_BASE_URL).toString() };
  }

  /** Idempotent: revoking a revoked token returns it unchanged, keeping the first `revoked_at`. */
  async revoke(id: string): Promise<ShareToken> {
    const { client, workspaceId } = this.store();
    const existing = await this.loadForUpdate(client, id);
    if (existing.revoked_at !== null) return toShareToken(existing);
    const updated = await client.query<TokenRow>(`UPDATE share_tokens SET revoked_at = now() WHERE id = $1 RETURNING ${COLUMNS}`, [id]);
    incrementCounter("nominara_share_token_revocations_total");
    this.logger.log(`share token revoked workspace_id=${workspaceId} share_token_id=${id}`);
    return toShareToken(updated.rows[0]!);
  }

  /** Telemetry, newest first. `pages`, `duration_s` and `geo` are null (not recorded), never 0, until a source exists. */
  async views(id: string): Promise<ShareTokenView[]> {
    const { client } = this.store();
    await this.loadVisible(client, id);
    const result = await client.query<{
      viewed_at: Date;
      ip: string | null;
      country: string | null;
      user_agent: string | null;
      authenticated: boolean;
      pages: number | null;
      duration_s: number | null;
    }>(
      `SELECT viewed_at, host(ip) AS ip, country, user_agent, authenticated,
              NULLIF(cardinality(pages_viewed), 0) AS pages,
              duration_ms::float8 / 1000 AS duration_s
         FROM share_token_views
        WHERE share_token_id = $1
        ORDER BY viewed_at DESC, id
        LIMIT ${String(VIEWS_PAGE_LIMIT)}`,
      [id],
    );
    return result.rows.map((r) => ({
      at: r.viewed_at.toISOString(),
      ip: r.ip,
      geo: r.country,
      user_agent: r.user_agent,
      authenticated: r.authenticated,
      pages: r.pages,
      duration_s: r.duration_s,
    }));
  }

  // ---- STORY-098 part B: the portal gate. Called by PortalSessionService / PortalContextInterceptor, never by a controller of ours.

  /**
   * The pre-auth lookup: resolves sha256(secret) to the gate row through `app.share_token_by_hash`, the one
   * SECURITY DEFINER function (migration 0080). Runs on a bare pool connection with NO tenant context, because the
   * workspace is exactly what this finds out. Returns null for an unknown hash.
   */
  async findForGate(pool: Pool, tokenHash: Buffer): Promise<GateRow | null> {
    const result = await pool.query<GateDbRow>("SELECT * FROM app.share_token_by_hash($1)", [tokenHash]);
    const r = result.rows[0];
    return r === undefined ? null : toGateRow(r);
  }

  /**
   * Serialises attempts on ONE token: the row lock is taken before any password is verified and held to the end of the
   * transaction (Argon2 is local CPU, not an external call). That is what makes the 5-failure limit a limit: parallel
   * guesses queue behind the lock, and each sees the lock the previous one set. Null if the token is not visible to
   * the context (another workspace's, by RLS).
   */
  async lockForAttempt(id: string): Promise<GateRow | null> {
    const { client } = this.store();
    const result = await client.query<GateDbRow>(
      `SELECT id, workspace_id, password_hash, password_required, scope_project_ids, scope_tabs, theme_id,
              COALESCE(allowed_email_domains::text[], ARRAY[]::text[]) AS allowed_email_domains,
              revoked_at, expires_at, max_views, view_count, locked_until
         FROM share_tokens WHERE id = $1 FOR UPDATE`,
      [id],
    );
    const r = result.rows[0];
    return r === undefined ? null : toGateRow(r);
  }

  /**
   * One wrong (or missing) password. The UPDATE takes the row lock, so concurrent attempts serialise and none can
   * slip past the limit. The 5th failure sets the 15-minute lock and restarts the count from zero.
   * A token the context cannot see (another workspace's, by RLS) updates nothing and reports no lock.
   */
  async recordFailedPassword(id: string): Promise<{ lockedUntil: Date | null }> {
    const { client } = this.store();
    const result = await client.query<{ locked_until: Date | null; just_locked: boolean }>(
      `UPDATE share_tokens
          SET failed_attempts = CASE WHEN COALESCE(failed_attempts, 0) + 1 >= $2 THEN 0 ELSE COALESCE(failed_attempts, 0) + 1 END,
              locked_until    = CASE WHEN COALESCE(failed_attempts, 0) + 1 >= $2 THEN now() + make_interval(secs => $3::float8 / 1000) ELSE locked_until END
        WHERE id = $1
        RETURNING locked_until, (failed_attempts = 0) AS just_locked`,
      [id, PASSWORD_FAILURE_LIMIT, PASSWORD_LOCK_MS],
    );
    const row = result.rows[0];
    return { lockedUntil: row !== undefined && row.just_locked ? row.locked_until : null };
  }

  /**
   * A session mint (FR-AGY-01m, scenario 18): one atomic statement re-checks revoked / expiry / view cap, increments
   * `view_count`, clears the failure count and lock, and a view row is written in the same transaction. False means
   * the token was refused at the last possible moment (revoked or capped between lookup and now), and nothing was
   * written. The cap is evaluated inside the UPDATE, so N parallel mints on a cap of M produce exactly M sessions.
   */
  async consumeView(id: string, view: ViewFacts): Promise<boolean> {
    const { client, workspaceId } = this.store();
    const updated = await client.query(
      `UPDATE share_tokens
          SET view_count = view_count + 1, last_viewed_at = now(), failed_attempts = 0, locked_until = NULL
        WHERE id = $1
          AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > now())
          AND (max_views IS NULL OR view_count < max_views)
          AND (locked_until IS NULL OR locked_until <= now())`,
      [id],
    );
    if (updated.rowCount !== 1) return false;
    await client.query(
      `INSERT INTO share_token_views (workspace_id, share_token_id, ip, user_agent, authenticated) VALUES ($1, $2, $3::inet, $4, $5)`,
      [workspaceId, id, view.ip, view.userAgent, view.authenticated],
    );
    return true;
  }

  /**
   * FR-AGY-01m, checked on EVERY portal request: is the session's token still live? Revoked and expired end it.
   * The view cap is NOT a mid-session condition: `view_count == max_views` is the session that took the last
   * permitted view, and it must keep working; only a count ABOVE the cap (which the mint's atomic check forbids) is
   * refused here, as defence in depth. Scoped to the context's workspace by RLS, so another workspace's id is false.
   */
  async isSessionLive(id: string): Promise<boolean> {
    const { client, workspaceId } = this.store();
    // RLS already hides another workspace's row; the explicit predicate keeps the answer right on a connection that is
    // not subject to RLS (a superuser test harness), where a cookie naming the wrong workspace must still be refused.
    const result = await client.query<{ revoked_at: Date | null; expires_at: Date | null; max_views: number | null; view_count: number }>(
      `SELECT revoked_at, expires_at, max_views, view_count FROM share_tokens WHERE id = $1 AND workspace_id = $2`,
      [id, workspaceId],
    );
    const row = result.rows[0];
    if (row === undefined) return false;
    const refusal = gateRefusal({ revokedAt: row.revoked_at, expiresAt: row.expires_at, maxViews: row.max_views, viewCount: row.view_count - 1 /* gateRefusal is >=; this makes it > */ }, new Date());
    return refusal === null;
  }

  private async loadVisible(client: ClientBase, id: string): Promise<TokenRow> {
    const result = await client.query<TokenRow>(`SELECT ${COLUMNS} FROM share_tokens WHERE id = $1`, [id]);
    return this.requireInScope(result.rows[0]);
  }

  private async loadForUpdate(client: ClientBase, id: string): Promise<TokenRow> {
    const result = await client.query<TokenRow>(`SELECT ${COLUMNS} FROM share_tokens WHERE id = $1 FOR UPDATE`, [id]);
    return this.requireInScope(result.rows[0]);
  }

  private requireInScope(row: TokenRow | undefined): TokenRow {
    // RLS hides another workspace's row, so a foreign id is indistinguishable from an absent one, by design.
    if (row === undefined) throw new NotFoundError({ message: "no such share token" });
    const { actorScope } = this.store();
    if (actorScope !== null && row.scope_project_ids.some((p) => !actorScope.includes(p))) throw new ProjectOutOfScopeError();
    return row;
  }

  /** scope_project_ids must be readable in this tenant context (RLS hides other workspaces' projects). */
  private async assertProjectsReadable(client: ClientBase, projectIds: readonly string[]): Promise<void> {
    const found = await client.query<{ id: string }>(`SELECT id FROM projects WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`, [projectIds]);
    const known = new Set(found.rows.map((r) => r.id));
    const missing = projectIds.findIndex((id) => !known.has(id));
    if (missing !== -1) {
      throw new ValidationFailedError({
        message: "scope_project_ids names a project that does not exist in this workspace",
        details: { issues: [{ path: ["scope_project_ids", missing], message: "no such project" }] },
      });
    }
  }

  private async assertThemeInWorkspace(client: ClientBase, themeId: string): Promise<void> {
    const found = await client.query(`SELECT 1 FROM brand_themes WHERE id = $1`, [themeId]);
    if (found.rows.length === 0) {
      throw new ValidationFailedError({
        message: "theme_id does not name a theme of this workspace",
        details: { issues: [{ path: ["theme_id"], message: "no such theme" }] },
      });
    }
  }

  /** Structural limit (`403 entitlement_exceeded` with {key,limit,current}); serialised per workspace so concurrent mints cannot both pass. */
  private async assertWithinActiveLimit(client: ClientBase, workspaceId: string): Promise<void> {
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`share_tokens:${workspaceId}`]);
    const resolved = await resolveEntitlements(client, workspaceId);
    const limit = activeLinkLimit(resolved.entitlements[ENTITLEMENT_KEY]?.value);
    if (limit === null) return;
    const counted = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM share_tokens WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`,
    );
    const current = counted.rows[0]?.n ?? 0;
    if (current >= limit) {
      throw new EntitlementExceededError({
        message: `${ENTITLEMENT_KEY}: ${String(current)} of ${String(limit)} active share links in use`,
        details: { key: ENTITLEMENT_KEY, limit, current },
      });
    }
  }

  private store(): { client: ClientBase; workspaceId: string; actorId: string; actorScope: readonly string[] | null } {
    const store = currentTenantStore();
    if (store === undefined) throw new Error("ShareTokensService requires an active tenant context");
    const scope = store.context.scopeProjectIds;
    return {
      client: store.client,
      workspaceId: store.context.workspaceId,
      actorId: store.context.actorId,
      actorScope: scope !== undefined && scope.length > 0 ? scope : null,
    };
  }
}
