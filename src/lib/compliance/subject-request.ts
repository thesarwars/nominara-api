import { randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";
import type { ClientBase } from "pg";
import {
  subjectExportSchema,
  type SubjectExport,
  type SubjectExportMetric,
  type SubjectRequestAuditAction,
  type SubjectRequestKind,
} from "../../../contracts/compliance/index.js";
import { buildMethodologyFooter } from "../reports/methodology-footer.js";
import { CROSS_ENGINE_KEY } from "../rollup/roll-up-day.js";
import { incrementCounter } from "../telemetry/metrics.js";
import { requestIndividualErasure } from "../../workers/rollup/retention.js";
import { appendComplianceAudit } from "./compliance-audit.js";
import { activeHolds } from "./legal-hold.js";
import { SUBJECT_INVENTORY } from "./subject-inventory.js";

// STORY-111 / NFR-CMP-02, NFR-CMP-03, NFR-CMP-13 - subject requests: right of access and portability, and right to erasure.
//
// This runs on the OWNER connection (cross-tenant discovery and the erasure's trigger DDL both need it - retention.ts's PRIVILEGE
// CONTRACT), so it is invoked by the operator CLI / a job, never inline in a request handler. The HTTP intake route is NOT built: the
// api-specification names none (see docs/plans/story-111-evidence.md).
//
// AUDIT, END TO END: `subject_request.received` -> `.processed` -> `.completed` (or `.blocked` / `.failed`), each written to the audit log
// of EVERY workspace the subject belongs to, with the requester recorded as the actor. The identifier that ties them is `request_id`.
// A subject with no workspace has nothing to audit in a workspace chain and nothing to export from one.

export interface SubjectRequestContext {
  /** The person raising the request: the subject themself, or the operator acting for them. null = the system. */
  readonly requestedBy: string | null;
  readonly requestId?: string;
  readonly now?: Date;
}

const logger = new Logger("subject-request");

export const MAX_ROWS_PER_TABLE = 10_000;
export const METRIC_TIMEFRAME = "30d" as const;

export const SOLE_OWNER_BLOCK_PATH =
  "Transfer ownership of the workspace to another member (POST /v1/workspaces/{id}/transfer-ownership), or delete the workspace, then request erasure again.";

/** Every workspace the subject has a membership row in, removed ones included: these are the audit chains the request is traced in. */
async function workspacesOf(client: ClientBase, userId: string): Promise<string[]> {
  const rows = await client.query<{ workspace_id: string }>("SELECT DISTINCT workspace_id FROM workspace_members WHERE user_id = $1", [userId]);
  return rows.rows.map((r) => r.workspace_id);
}

async function audit(
  client: ClientBase,
  workspaceIds: readonly string[],
  action: SubjectRequestAuditAction,
  kind: SubjectRequestKind,
  ctx: { requestId: string; requestedBy: string | null },
  extra: Record<string, unknown> = {},
): Promise<void> {
  for (const workspaceId of workspaceIds) {
    await appendComplianceAudit(client, {
      workspaceId,
      actorType: ctx.requestedBy === null ? "system" : "user",
      actorId: ctx.requestedBy,
      action,
      resourceType: "subject_request",
      resourceId: ctx.requestId,
      // No subject identifier here: after an erasure this row survives, and a surviving subject id would defeat the pseudonymisation.
      afterState: { request_id: ctx.requestId, kind, ...extra },
      severity: "notice",
      requestId: ctx.requestId,
    });
  }
  incrementCounter("nominara_compliance_subject_request_events_total", { action, kind });
  // A subject with NO membership has no workspace chain to write to; the request is still traced, by id, here. The line carries the request id,
  // the kind, the step and a count - never the subject's identifier, email or name.
  logger.log({ event: "subject_request", request_id: ctx.requestId, kind, action, audited_workspaces: workspaceIds.length });
}

async function foreignKeyColumnsToUsers(client: ClientBase, table: string): Promise<string[]> {
  const rows = await client.query<{ column_name: string }>(
    `SELECT a.attname AS column_name
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       JOIN pg_class f ON f.oid = c.confrelid
       JOIN LATERAL unnest(c.conkey) AS k(attnum) ON true
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
      WHERE c.contype = 'f' AND n.nspname = 'public' AND t.relname = $1 AND f.relname = 'users'
      ORDER BY a.attname`,
    [table],
  );
  return rows.rows.map((r) => r.column_name);
}

/**
 * The columns that select a table's rows for a subject: the declared `subjectColumns` when the entry narrows them, otherwise every foreign key
 * to users(id) plus the declared FK-less actor columns.
 */
export async function subjectColumnsFor(client: ClientBase, table: string): Promise<string[]> {
  const entry = SUBJECT_INVENTORY[table];
  if (entry === undefined || entry.disposition !== "export") return [];
  if (entry.subjectColumns !== undefined) return [...entry.subjectColumns].sort();
  const found = await foreignKeyColumnsToUsers(client, table);
  return [...new Set([...found, ...(entry.extraColumns ?? [])])].sort();
}

const quote = (identifier: string): string => `"${identifier.replaceAll('"', '""')}"`;

async function exportTable(client: ClientBase, table: string, userId: string) {
  const entry = SUBJECT_INVENTORY[table];
  if (entry === undefined || entry.disposition !== "export") return null;
  const subjectColumns = await subjectColumnsFor(client, table);
  if (subjectColumns.length === 0) return null;
  const live = await client.query<{ column_name: string }>(
    "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1",
    [table],
  );
  const present = new Set(live.rows.map((c) => c.column_name));
  // DEFAULT-DENY: only a column the registry declares exportable is selected. An undeclared column is not read at all.
  const kept = entry.columns.filter((c) => present.has(c));
  if (kept.length === 0) return null;
  // A user id that is not the subject's belongs to someone else: it is exported as null (Art. 15(4)). Actor columns without a foreign key
  // (audit_log.actor_id, credit_ledger.actor_id) are selected on the subject, so they can only ever hold the subject's id.
  const userRefs = new Set(await foreignKeyColumnsToUsers(client, table));
  // Identifiers come from the registry and the catalogue (never from a caller) and are quoted; the subject id is a parameter.
  const select = kept.map((c) => (userRefs.has(c) ? `CASE WHEN ${quote(c)} = $1 THEN ${quote(c)} END AS ${quote(c)}` : quote(c))).join(", ");
  const where = subjectColumns.map((c) => `${quote(c)} = $1`).join(" OR ");
  const result = await client.query(`SELECT ${select} FROM ${quote(table)} WHERE ${where} LIMIT ${String(MAX_ROWS_PER_TABLE + 1)}`, [userId]);
  const truncated = result.rows.length > MAX_ROWS_PER_TABLE;
  const rows = truncated ? result.rows.slice(0, MAX_ROWS_PER_TABLE) : result.rows;
  if (rows.length === 0) return null;
  return { table, subject_columns: subjectColumns, omitted_columns: [...entry.omit], row_count: rows.length, truncated, rows: rows as Record<string, unknown>[] };
}

/**
 * The Visibility Score of each project the subject created, with the six facts that say what the number meant (NFR-CMP-13). `value` is null
 * when no cross-engine score exists in the window - never 0 for "nothing measured". Only workspaces where the subject is an ACTIVE member: the
 * score is the workspace's current measurement, and a member who was removed no longer has access to it (this runs on the owner connection, so
 * the membership check is the access check).
 */
async function exportMetrics(client: ClientBase, userId: string): Promise<SubjectExportMetric[]> {
  const projects = await client.query<{ id: string; workspace_id: string; scoring_version: string; timezone: string }>(
    `SELECT p.id, p.workspace_id, w.scoring_version, w.timezone
       FROM projects p
       JOIN workspaces w ON w.id = p.workspace_id
       JOIN workspace_members m ON m.workspace_id = p.workspace_id AND m.user_id = $1 AND m.status = 'active'
      WHERE p.created_by = $1 AND p.deleted_at IS NULL ORDER BY p.created_at, p.id`,
    [userId],
  );
  const metrics: SubjectExportMetric[] = [];
  for (const project of projects.rows) {
    const window = await client.query<{ from: string; to: string }>(
      `SELECT to_char(today - make_interval(days => 29), 'YYYY-MM-DD') AS from, to_char(today, 'YYYY-MM-DD') AS to
         FROM (SELECT (now() AT TIME ZONE $1)::date AS today) t`,
      [project.timezone],
    );
    const { from, to } = window.rows[0]!;
    const through = await client.query<{ data_through: string | null }>(
      "SELECT to_char(max(metric_date), 'YYYY-MM-DD') AS data_through FROM metric_daily WHERE project_id = $1 AND scoring_version = $2",
      [project.id, project.scoring_version],
    );
    const engines = await client.query<{ engine_key: string; sample_size: string; live_capture_ratio: number | null }>(
      `SELECT engine_key, sum(cells_total)::text AS sample_size,
              CASE WHEN sum(cells_total) > 0 THEN (sum(cells_total * live_capture_ratio) / sum(cells_total))::float8 END AS live_capture_ratio
         FROM metric_daily
        WHERE project_id = $1 AND scoring_version = $2 AND entity_type = 'brand' AND engine_key <> $3 AND metric_date BETWEEN $4::date AND $5::date
        GROUP BY engine_key`,
      [project.id, project.scoring_version, CROSS_ENGINE_KEY, from, to],
    );
    const latest = await client.query<{ visibility_score: string }>(
      `SELECT visibility_score::text FROM metric_daily
        WHERE project_id = $1 AND scoring_version = $2 AND entity_type = 'brand' AND engine_key = $3 AND metric_date BETWEEN $4::date AND $5::date
        ORDER BY metric_date DESC LIMIT 1`,
      [project.id, project.scoring_version, CROSS_ENGINE_KEY, from, to],
    );
    const footer = buildMethodologyFooter({
      dataThrough: through.rows[0]?.data_through ?? null,
      timeframe: METRIC_TIMEFRAME,
      scoringVersion: project.scoring_version,
      weightOverrides: null,
      // The per-engine live/demo marker needs the tenant-scoped provenance helper; "unknown" (null) is stated, not guessed.
      engines: engines.rows.map((row) => ({ engineKey: row.engine_key, dataSource: null, sampleSize: Number(row.sample_size), liveCaptureRatio: row.live_capture_ratio })),
    });
    const score = latest.rows[0]?.visibility_score;
    metrics.push({
      workspace_id: project.workspace_id,
      project_id: project.id,
      metric: "visibility_score",
      value: score === undefined ? null : Number(score),
      metadata: {
        scoring_version: footer.scoring_version,
        engines: footer.engines,
        timeframe: footer.timeframe as typeof METRIC_TIMEFRAME,
        sample_size: footer.sample_size,
        live_capture_ratio: footer.live_capture_ratio,
        data_through: footer.data_through,
      },
    });
  }
  return metrics;
}

export async function processAccessRequest(client: ClientBase, userId: string, ctx: SubjectRequestContext): Promise<SubjectExport> {
  const requestId = ctx.requestId ?? randomUUID();
  const now = ctx.now ?? new Date();
  const audited = { requestId, requestedBy: ctx.requestedBy };
  const workspaceIds = await workspacesOf(client, userId);
  await audit(client, workspaceIds, "subject_request.received", "access", audited);
  try {
    const profile = await client.query(
      `SELECT id, email, email_verified_at, full_name, avatar_url, locale, timezone, persona_org_type, persona_volume_band, persona_focus,
              status, last_login_at, created_at FROM users WHERE id = $1`,
      [userId],
    );
    const tables = [];
    for (const [table, entry] of Object.entries(SUBJECT_INVENTORY)) {
      if (entry.disposition !== "export") continue;
      const exported = await exportTable(client, table, userId);
      if (exported !== null) tables.push(exported);
    }
    await audit(client, workspaceIds, "subject_request.processed", "access", audited, { tables: tables.length });
    const metrics = await exportMetrics(client, userId);
    const document = subjectExportSchema.parse({
      format_version: 1,
      request_id: requestId,
      subject_user_id: userId,
      generated_at: now.toISOString(),
      profile: profile.rows[0] ?? null,
      tables,
      metrics,
    });
    await audit(client, workspaceIds, "subject_request.completed", "access", { requestId, requestedBy: ctx.requestedBy }, { rows: tables.reduce((n, t) => n + t.row_count, 0) });
    return document;
  } catch (error) {
    await audit(client, workspaceIds, "subject_request.failed", "access", audited, { error: error instanceof Error ? error.name : "unknown" });
    throw error;
  }
}

export interface ErasureOutcome {
  readonly requestId: string;
  readonly status: "completed" | "blocked";
  /** The exact reason and the way forward, stated to the requester. null when completed. */
  readonly reason: string | null;
  /**
   * Workspaces of the subject that were under an ACTIVE legal hold when the erasure ran. The erasure is not blocked by a hold (the audit rows are
   * pseudonymised, not deleted - see the evidence file for the owner question); it is REPORTED so the operator knows evidence was altered.
   */
  readonly heldWorkspaces: readonly string[];
}

export async function processErasureRequest(client: ClientBase, userId: string, ctx: SubjectRequestContext): Promise<ErasureOutcome> {
  const requestId = ctx.requestId ?? randomUUID();
  const audited = { requestId, requestedBy: ctx.requestedBy };
  // Captured BEFORE the erasure: it marks memberships removed, and these are the chains the trail is written to.
  const workspaceIds = await workspacesOf(client, userId);
  const holds = await activeHolds(client, ctx.now ?? new Date());
  const heldWorkspaces = workspaceIds.filter((w) => holds.workspaces.has(w) || holds.workspacesWithHeldProject.has(w));
  await audit(client, workspaceIds, "subject_request.received", "erasure", audited);
  try {
    const result = await requestIndividualErasure(client, userId);
    if (result.blocked) {
      const reason = `${result.reason} ${SOLE_OWNER_BLOCK_PATH}`;
      await audit(client, workspaceIds, "subject_request.blocked", "erasure", audited, { blocked_reason: "sole_owner" });
      return { requestId, status: "blocked", reason, heldWorkspaces: [] };
    }
    // The steps after the erasure are the SYSTEM's (no actor id): the requester's id is pseudonymised away by the erasure itself, and a surviving
    // user id on these rows would defeat that.
    const after = { requestId, requestedBy: null };
    await audit(client, workspaceIds, "subject_request.processed", "erasure", after, heldWorkspaces.length > 0 ? { legal_hold_workspaces: heldWorkspaces.length } : {});
    await audit(client, workspaceIds, "subject_request.completed", "erasure", after, {});
    return { requestId, status: "completed", reason: null, heldWorkspaces };
  } catch (error) {
    await audit(client, workspaceIds, "subject_request.failed", "erasure", audited, { error: error instanceof Error ? error.name : "unknown" });
    throw error;
  }
}
