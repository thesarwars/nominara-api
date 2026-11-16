import { Injectable } from "@nestjs/common";
import type { ClientBase } from "pg";
import type { AuditChainRow } from "../../lib/crypto/audit-chain.js";

// STORY-020 D-3 — service-layer only, no HTTP route and no role enforcement
// yet (disclosed as STORY-020-E-8 in the story file): wire to
// @RequirePermission('audit_log:read') once STORY-019/021 lands. Explicit
// workspace_id filter is defense in depth alongside RLS, matching
// AuditChainService's own pattern — this service is meant to be usable
// correctly even called on a client without tenant context set.

export interface AuditQueryFilter {
  readonly workspaceId: string;
  readonly action?: string;
  readonly actorId?: string;
  readonly occurredFrom?: string;
  readonly occurredTo?: string;
  /** Exclusive upper bound — `occurredTo` is inclusive, so a whole-day range cannot be expressed with it. */
  readonly occurredBefore?: string;
  readonly severity?: string;
  /** NEW-D-3 — keyset: only rows with `seq` strictly below this (the list is newest-first). */
  readonly beforeSeq?: string;
  /** NEW-D-3 — namespace prefixes (`billing.`), matched with starts_with(), never LIKE. */
  readonly actionPrefixes?: readonly string[];
  readonly excludeActionPrefixes?: readonly string[];
  /** Exact actions OR-ed with `actionPrefixes` (a category's reserved actions); `actionsNotIn` excludes exact actions. */
  readonly actionsIn?: readonly string[];
  readonly actionsNotIn?: readonly string[];
  readonly limit?: number;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

@Injectable()
export class AuditQueryService {
  async query(client: ClientBase, filter: AuditQueryFilter): Promise<readonly AuditChainRow[]> {
    const conditions: string[] = ["workspace_id = $1"];
    const params: unknown[] = [filter.workspaceId];

    if (filter.action !== undefined) {
      params.push(filter.action);
      conditions.push(`action = $${params.length}`);
    }
    if (filter.actorId !== undefined) {
      params.push(filter.actorId);
      conditions.push(`actor_id = $${params.length}`);
    }
    if (filter.occurredFrom !== undefined) {
      params.push(filter.occurredFrom);
      conditions.push(`occurred_at >= $${params.length}`);
    }
    if (filter.occurredTo !== undefined) {
      params.push(filter.occurredTo);
      conditions.push(`occurred_at <= $${params.length}`);
    }

    if (filter.occurredBefore !== undefined) {
      params.push(filter.occurredBefore);
      conditions.push(`occurred_at < $${params.length}::timestamptz`);
    }
    if (filter.severity !== undefined) {
      params.push(filter.severity);
      conditions.push(`severity = $${params.length}`);
    }
    if (filter.beforeSeq !== undefined) {
      params.push(filter.beforeSeq);
      conditions.push(`audit_log.seq < $${params.length}::int8`);
    }
    if ((filter.actionPrefixes?.length ?? 0) > 0 || (filter.actionsIn?.length ?? 0) > 0) {
      const tests = (filter.actionPrefixes ?? []).map((prefix) => {
        params.push(prefix);
        return `starts_with(action, $${params.length})`;
      });
      for (const exact of filter.actionsIn ?? []) {
        params.push(exact);
        tests.push(`action = $${params.length}`);
      }
      conditions.push(`(${tests.join(" OR ")})`);
    }
    for (const prefix of filter.excludeActionPrefixes ?? []) {
      params.push(prefix);
      conditions.push(`NOT starts_with(action, $${params.length})`);
    }

    for (const exact of filter.actionsNotIn ?? []) {
      params.push(exact);
      conditions.push(`action <> $${params.length}`);
    }

    const limit = Math.min(filter.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    params.push(limit);

    const result = await client.query(
      `SELECT audit_log.seq, workspace_id, occurred_at, actor_type, actor_id, host(actor_ip) AS actor_ip, actor_ua,
              action, resource_type, resource_id, before_state, after_state, request_id, support_grant_id,
              severity, prev_hash, row_hash
         FROM audit_log
        WHERE ${conditions.join(" AND ")}
        ORDER BY audit_log.seq DESC
        LIMIT $${params.length}`,
      params,
    );

    return result.rows.map((row: Record<string, unknown>) => ({
      ...row,
      occurred_at: (row.occurred_at as Date).toISOString(),
    })) as AuditChainRow[];
  }
}
