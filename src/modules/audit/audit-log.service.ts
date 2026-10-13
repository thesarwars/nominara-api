import { Injectable, Logger } from "@nestjs/common";
import type { AuditLogEntry, AuditLogQuery } from "../../../contracts/trust/index.js";
import { ValidationFailedError } from "../../api/errors/domain-errors.js";
import { decodeCursor } from "../../api/pagination/cursor.js";
import { pageFrom, type Page } from "../../api/pagination/page.js";
import type { AuditChainRow } from "../../lib/crypto/audit-chain.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { currentTenantStore } from "../../tenancy/tenant-context.js";
import { AuditQueryService } from "./audit-query.service.js";

// NEW-D-3 — api-specification.md §3 `GET /audit-log`. This WRAPS
// AuditQueryService (the one query path over audit_log — there is no second);
// everything here is shaping: category, cursor, date bounds, redaction.

type Category = AuditLogEntry["category"];

/**
 * OWNER DECISION: category is derived from the action namespace — the segment
 * before the first dot — and there is no category column. A namespace not in
 * this table is `data`, so a new action family is visible rather than dropped.
 */
const NAMESPACE_CATEGORY: Readonly<Record<string, Exclude<Category, "data">>> = {
  auth: "security",
  apikey: "security",
  support: "security",
  billing: "billing",
  workspace: "workspace",
  member: "workspace",
};

export function categoryOf(action: string): Category {
  const dot = action.indexOf(".");
  if (dot < 0) return "data";
  return NAMESPACE_CATEGORY[action.slice(0, dot)] ?? "data";
}

const prefixesOf = (category: Exclude<Category, "data">): string[] =>
  Object.entries(NAMESPACE_CATEGORY)
    .filter(([, value]) => value === category)
    .map(([namespace]) => `${namespace}.`);

/** The SQL-side mirror of `categoryOf`: `data` is the complement of every mapped namespace. */
export function categoryPredicate(category: Category): { include?: string[]; exclude?: string[] } {
  if (category === "data") return { exclude: Object.keys(NAMESPACE_CATEGORY).map((namespace) => `${namespace}.`) };
  return { include: prefixesOf(category) };
}

function utcMidnight(day: string): number {
  const ms = Date.parse(day + "T00:00:00.000Z");
  // Date.parse accepts nothing for 2026-02-31 in some engines and rolls it over in others; the round trip settles it.
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== day) {
    throw new ValidationFailedError({
      message: "invalid date",
      details: { issues: [{ path: ["date"], message: `${day} is not a calendar date` }] },
    });
  }
  return ms;
}

export const dayStart = (day: string): string => new Date(utcMidnight(day)).toISOString();
/** The exclusive bound that makes an inclusive `to=YYYY-MM-DD` mean the whole day. */
export const dayAfter = (day: string): string => new Date(utcMidnight(day) + 86_400_000).toISOString();

/**
 * Never exposes prev_hash/row_hash (as a field or as any value, e.g. the `id`),
 * before_state/after_state, or the IP. The `id` is the row's seq (see the entry schema).
 */
export function toAuditLogEntry(row: AuditChainRow): AuditLogEntry {
  return {
    id: row.seq,
    occurred_at: row.occurred_at,
    actor_type: row.actor_type,
    actor_id: row.actor_id,
    action: row.action,
    category: categoryOf(row.action),
    resource_type: row.resource_type,
    resource_id: row.resource_id,
    severity: row.severity,
    request_id: row.request_id,
    support_grant_id: row.support_grant_id,
  } as AuditLogEntry;
}

@Injectable()
export class AuditLogService {
  private readonly logger = new Logger(AuditLogService.name);

  constructor(private readonly query: AuditQueryService) {}

  async list(request: AuditLogQuery): Promise<Page<AuditLogEntry>> {
    const store = currentTenantStore();
    // Refuse rather than query on a connection with no workspace set.
    if (store === undefined) throw new Error("AuditLogService requires an active tenant context");

    // Seq is the ONLY cursor key: occurred_at is transaction-start time and many
    // rows share a microsecond, so a timestamp key skips rows at page boundaries.
    const beforeSeq = request.cursor === undefined ? undefined : seqFrom(decodeCursor(request.cursor, "trust.audit_log", 1));
    const category = request.category === undefined ? undefined : categoryPredicate(request.category);

    const rows = await this.query.query(store.client, {
      workspaceId: store.context.workspaceId,
      ...(request.action !== undefined && { action: request.action }),
      ...(request.actor_id !== undefined && { actorId: request.actor_id }),
      ...(request.severity !== undefined && { severity: request.severity }),
      ...(request.from !== undefined && { occurredFrom: dayStart(request.from) }),
      ...(request.to !== undefined && { occurredBefore: dayAfter(request.to) }),
      ...(beforeSeq !== undefined && { beforeSeq }),
      ...(category?.include !== undefined && { actionPrefixes: category.include }),
      ...(category?.exclude !== undefined && { excludeActionPrefixes: category.exclude }),
      limit: request.limit + 1,
    });

    incrementCounter("nominara_audit_log_reads_total", { outcome: "ok" });
    // The workspace ID only — never its name, never row content.
    this.logger.log({ message: "audit log read", workspace_id: store.context.workspaceId, rows: Math.min(rows.length, request.limit) });

    return pageFrom(rows, request.limit, "trust.audit_log", toAuditLogEntry, (row) => [row.seq]);
  }
}

function seqFrom(key: readonly (string | number | null)[]): string {
  const value = key[0];
  if (typeof value !== "string" || !/^[0-9]{1,18}$/u.test(value)) {
    throw new ValidationFailedError({
      message: "invalid pagination cursor",
      details: { issues: [{ path: ["cursor"], message: "cursor does not carry a sequence key" }] },
    });
  }
  return value;
}
