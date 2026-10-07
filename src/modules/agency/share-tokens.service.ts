import { createHash, randomBytes } from "node:crypto";
import { Injectable, Logger } from "@nestjs/common";
import type { ClientBase } from "pg";
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
    return { token: toShareToken(row), secret, url: `${PORTAL_BASE_URL}/r/${secret}` };
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
