import { createHash, randomBytes } from "node:crypto";
import { Injectable, Logger } from "@nestjs/common";
import type { ClientBase } from "pg";
import type { ApiKey, ApiKeyListQuery, CreateApiKeyRequest, CreatedApiKey } from "../../../contracts/workspaces/api-key.schema.js";
import { decodeCursor } from "../../api/pagination/cursor.js";
import { pageFrom, type Page } from "../../api/pagination/page.js";
import { EntitlementExceededError, NotFoundError, ValidationFailedError } from "../../api/errors/domain-errors.js";
import { structuralLimitFrom, wouldExceed } from "../../lib/entitlements/classification.js";
import { resolveEntitlements } from "../../lib/entitlements/resolution.js";
import { evaluatePermission, type Permission } from "../../tenancy/permission-matrix.js";
import { PermissionDeniedException } from "../../tenancy/errors.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { currentTenantStore } from "../../tenancy/tenant-context.js";

const ENTITLEMENT_KEY = "api.keys_max";
const KEY_BODY_LENGTH = 22;
/** `nk_live_` + 4 characters: what the UI shows (schemas/identity-and-tenancy.md, `key_prefix`). */
export const API_KEY_PREFIX_LENGTH = 12;

/** `nk_live_{22 chars}` (security-and-tenancy.md §5). 17 CSPRNG bytes give 23 base64url characters; 22 are kept. */
export function generateApiKey(): string {
  return `nk_live_${randomBytes(17).toString("base64url").slice(0, KEY_BODY_LENGTH)}`;
}

/** sha256 of the full key — the only key-derived value persisted besides the prefix. */
export function hashApiKey(key: string): Buffer {
  return createHash("sha256").update(key).digest();
}

interface KeyRow {
  readonly id: string;
  readonly name: string;
  readonly key_prefix: string;
  readonly permissions: string[];
  readonly project_scope: string[] | null;
  readonly created_by: string;
  readonly last_used_at: Date | null;
  readonly expires_at: Date | null;
  readonly revoked_at: Date | null;
  readonly created_at: Date;
}

// Never selects key_hash: no read path can return it.
const COLUMNS = "id, name, key_prefix, permissions, project_scope, created_by, last_used_at, expires_at, revoked_at, created_at";

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

function toApiKey(row: KeyRow): ApiKey {
  return {
    id: row.id,
    name: row.name,
    key_prefix: row.key_prefix,
    permissions: row.permissions,
    project_scope: row.project_scope,
    created_by: row.created_by,
    last_used_at: iso(row.last_used_at),
    expires_at: iso(row.expires_at),
    revoked_at: iso(row.revoked_at),
    created_at: row.created_at.toISOString(),
  };
}

// NEW-D-4 — owns `api_keys`. Every statement runs on the request's
// context-carrying transaction, so RLS (`ws_isolation_api_keys`) scopes the
// workspace: a key of another workspace is simply absent, which is a 404 and
// never a 403. Authenticating WITH a key is out of scope (AuthGuard's apiKey path).
@Injectable()
export class ApiKeysService {
  private readonly logger = new Logger(ApiKeysService.name);

  /**
   * NEW-D-1 AC3 — keyset page ordered (created_at DESC, id DESC). The cursor key carries the
   * FULL-PRECISION created_at (microseconds), not the published millisecond one: a truncated key
   * would skip rows created within the same millisecond.
   */
  async list(query: ApiKeyListQuery): Promise<Page<ApiKey>> {
    const { client } = this.store();
    const after = query.cursor === undefined ? undefined : cursorKeyOf(query.cursor);
    const result = await client.query<KeyRow & { created_at_key: string }>(
      `SELECT ${COLUMNS}, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_key
         FROM api_keys
        WHERE ($1::timestamptz IS NULL OR (created_at, id) < ($1::timestamptz, $2::uuid))
        ORDER BY created_at DESC, id DESC
        LIMIT $3`,
      [after?.[0] ?? null, after?.[1] ?? null, query.limit + 1],
    );
    return pageFrom(result.rows, query.limit, "api_keys.api_keys", toApiKey, (row) => [row.created_at_key, row.id]);
  }

  async create(callerRole: string, body: CreateApiKeyRequest): Promise<CreatedApiKey> {
    // A key can hold only what its creator holds: an admin cannot mint owner-only authority.
    for (const permission of body.permissions) {
      if (evaluatePermission(callerRole, permission as Permission).access === "deny") throw new PermissionDeniedException(permission);
    }
    const { client, workspaceId, actorId } = this.store();
    if (body.project_scope !== null) await this.assertProjectsReadable(client, body.project_scope);
    await this.assertWithinKeyLimit(client, workspaceId);

    const secret = generateApiKey();
    const inserted = await client.query<KeyRow>(
      `INSERT INTO api_keys (workspace_id, name, key_prefix, key_hash, permissions, project_scope, created_by, expires_at)
       VALUES ($1,$2,$3,$4,$5::text[],$6::uuid[],$7,$8)
       RETURNING ${COLUMNS}`,
      [workspaceId, body.name, secret.slice(0, API_KEY_PREFIX_LENGTH), hashApiKey(secret), body.permissions, body.project_scope, actorId, body.expires_at],
    );
    const row = inserted.rows[0]!;
    incrementCounter("nominara_api_key_creations_total");
    this.logger.log(`api key created workspace_id=${workspaceId} api_key_id=${row.id}`);
    return { key: toApiKey(row), secret };
  }

  /** Idempotent: revoking a revoked key returns it unchanged, keeping the first `revoked_at`. */
  async revoke(id: string): Promise<ApiKey> {
    const { client, workspaceId } = this.store();
    const existing = await client.query<KeyRow>(`SELECT ${COLUMNS} FROM api_keys WHERE id = $1 FOR UPDATE`, [id]);
    const row = existing.rows[0];
    // RLS hides another workspace's row, so a foreign id is indistinguishable from an absent one, by design.
    if (row === undefined) throw new NotFoundError({ message: "no such API key" });
    if (row.revoked_at !== null) return toApiKey(row);
    const updated = await client.query<KeyRow>(`UPDATE api_keys SET revoked_at = now() WHERE id = $1 RETURNING ${COLUMNS}`, [id]);
    incrementCounter("nominara_api_key_revocations_total");
    this.logger.log(`api key revoked workspace_id=${workspaceId} api_key_id=${id}`);
    return toApiKey(updated.rows[0]!);
  }

  /**
   * STORY-021 / EC-15 — ownership transfer: "ALL keys, unconditionally. There is no retain option — a service
   * credential minted by a departed owner is never carried over". Every still-live key of the context's workspace
   * (RLS scopes the statement; there is deliberately no id list and no creator filter). Returns how many it revoked.
   */
  async revokeAll(): Promise<number> {
    const { client, workspaceId } = this.store();
    const result = await client.query(`UPDATE api_keys SET revoked_at = now() WHERE revoked_at IS NULL`);
    const count = result.rowCount ?? 0;
    if (count > 0) incrementCounter("nominara_api_key_revocations_total");
    this.logger.log(`api keys revoked on ownership transfer workspace_id=${workspaceId} count=${String(count)}`);
    return count;
  }

  /** project_scope must be readable in this tenant context (RLS hides other workspaces' projects). */
  private async assertProjectsReadable(client: ClientBase, projectIds: readonly string[]): Promise<void> {
    const found = await client.query<{ id: string }>(`SELECT id FROM projects WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`, [projectIds]);
    const known = new Set(found.rows.map((r) => r.id));
    const missing = projectIds.findIndex((id) => !known.has(id));
    if (missing !== -1) {
      throw new ValidationFailedError({
        message: "project_scope names a project that does not exist in this workspace",
        details: { issues: [{ path: ["project_scope", missing], message: "no such project" }] },
      });
    }
  }

  /**
   * `api.keys_max` (`403 entitlement_exceeded` with {key,limit,current}). The route's guard refuses the
   * ordinary case early; this re-check runs under a per-workspace lock so concurrent creates cannot both pass.
   * A revoked or expired key is not counted (structural-usage.ts).
   */
  private async assertWithinKeyLimit(client: ClientBase, workspaceId: string): Promise<void> {
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`api_keys:${workspaceId}`]);
    const resolved = await resolveEntitlements(client, workspaceId);
    const limit = structuralLimitFrom(resolved.entitlements[ENTITLEMENT_KEY]?.value as never);
    // An unreadable value fails closed rather than allowing an unbounded credential count.
    if (limit === undefined) {
      throw new EntitlementExceededError({ message: `${ENTITLEMENT_KEY}: unreadable limit`, details: { key: ENTITLEMENT_KEY, limit: 0, current: 0 } });
    }
    if (limit.kind === "unlimited") return;
    const counted = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM api_keys WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`,
    );
    const current = counted.rows[0]?.n ?? 0;
    if (wouldExceed(limit, current)) {
      throw new EntitlementExceededError({
        message: `${ENTITLEMENT_KEY}: ${String(current)} of ${String(limit.limit)} in use`,
        details: { key: ENTITLEMENT_KEY, limit: limit.limit, current },
      });
    }
  }

  private store(): { client: ClientBase; workspaceId: string; actorId: string } {
    const store = currentTenantStore();
    if (store === undefined) throw new Error("ApiKeysService requires an active tenant context");
    return { client: store.client, workspaceId: store.context.workspaceId, actorId: store.context.actorId };
  }
}

const ISO_MICROS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function cursorKeyOf(cursor: string): [string, string] {
  const [createdAt, id] = decodeCursor(cursor, "api_keys.api_keys", 2);
  if (typeof createdAt !== "string" || !ISO_MICROS.test(createdAt) || typeof id !== "string" || !UUID.test(id)) {
    throw new ValidationFailedError({
      message: "invalid pagination cursor",
      details: { issues: [{ path: ["cursor"], message: "cursor was not issued for this list" }] },
    });
  }
  return [createdAt, id];
}
