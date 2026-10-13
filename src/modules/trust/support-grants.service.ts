import { Injectable, Logger } from "@nestjs/common";
import type { AccessGrant, AccessGrantListQuery } from "../../../contracts/trust/access-grant.schema.js";
import { ValidationFailedError } from "../../api/errors/domain-errors.js";
import { decodeCursor } from "../../api/pagination/cursor.js";
import { pageFrom, type Page } from "../../api/pagination/page.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { currentTenantStore } from "../../tenancy/tenant-context.js";

interface GrantRow {
  readonly id: string;
  readonly scope: AccessGrant["scope"];
  readonly allow_write: boolean;
  readonly ticket_ref: string;
  readonly justification: string;
  readonly expires_at: Date;
  readonly created_at: Date;
  /** Microsecond-exact text of created_at: a JS Date would round it and skip rows at a page edge. */
  readonly created_key: string;
}

// NEW-D-5 — the READ side of `support_grants`. Writes are the ops CLI's
// (src/lib/support/support-grants.ts), deliberately not reachable from here.
// requested_by / approved_by are never selected: staff identities are not published.
@Injectable()
export class SupportGrantsService {
  private readonly logger = new Logger(SupportGrantsService.name);

  async list(request: AccessGrantListQuery): Promise<Page<AccessGrant>> {
    const store = currentTenantStore();
    if (store === undefined) throw new Error("SupportGrantsService requires an active tenant context");

    const after = request.cursor === undefined ? undefined : keyFrom(decodeCursor(request.cursor, "trust.support_grants", 2));
    const params: unknown[] = [];
    let keyset = "";
    if (after !== undefined) {
      params.push(after.createdKey, after.id);
      keyset = `AND (created_at, id) < ($1::timestamptz, $2::uuid)`;
    }
    params.push(request.limit + 1);
    // RLS scopes the workspace; the predicate below is the definition of "active".
    const result = await store.client.query<GrantRow>(
      `SELECT id, scope, allow_write, ticket_ref, justification, expires_at, created_at, created_at::text AS created_key
         FROM support_grants
        WHERE revoked_at IS NULL AND expires_at > now() ${keyset}
        ORDER BY created_at DESC, id DESC
        LIMIT $${String(params.length)}`,
      params,
    );
    incrementCounter("nominara_support_grants_reads_total", { outcome: "ok" });
    this.logger.log({ message: "access grants read", workspace_id: store.context.workspaceId, rows: Math.min(result.rows.length, request.limit) });
    return pageFrom(result.rows, request.limit, "trust.support_grants", toGrant, (row) => [row.created_key, row.id]);
  }
}

function toGrant(row: GrantRow): AccessGrant {
  return {
    id: row.id,
    scope: row.scope,
    allow_write: row.allow_write,
    ticket_ref: row.ticket_ref,
    justification: row.justification,
    expires_at: row.expires_at.toISOString(),
    created_at: row.created_at.toISOString(),
  };
}

function keyFrom(key: readonly (string | number | null)[]): { createdKey: string; id: string } {
  const [createdKey, id] = key;
  if (typeof createdKey !== "string" || typeof id !== "string" || !/^[0-9a-f-]{36}$/iu.test(id) || Number.isNaN(Date.parse(createdKey))) {
    throw new ValidationFailedError({
      message: "invalid pagination cursor",
      details: { issues: [{ path: ["cursor"], message: "cursor does not carry a grant key" }] },
    });
  }
  return { createdKey, id };
}
