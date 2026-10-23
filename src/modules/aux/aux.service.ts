import { Injectable, Logger } from "@nestjs/common";
import { AUX_CATEGORY_WEIGHTS } from "../../lib/scoring/aux.js";
import type {
  AuxAudit,
  AuxAuditListQuery,
  AuxFinding,
  AuxFindingListQuery,
  UpdateAuxFindingRequest,
} from "../../../contracts/aux/index.js";
import { AUX_CATEGORIES } from "../../../contracts/aux/index.js";
import type { AuxPatch } from "../../../contracts/aux/index.js";
import { guidanceFor } from "../../lib/aux/patches/guidance.js";
import { pageMatches, sha256Tag, type LatestAuditFacts } from "../../lib/aux/patches/precondition.js";
import { ConflictError, NotFoundError, PreconditionUnmetError } from "../../api/errors/domain-errors.js";
import { decodeCursor } from "../../api/pagination/cursor.js";
import { Page, pageFrom } from "../../api/pagination/page.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { ProjectOutOfScopeException } from "../../tenancy/errors.js";
import { currentTenantStore } from "../../tenancy/tenant-context.js";

// NEW-C-10 (STORY-052; api-specification.md "AUX") — the AUX read side and the
// two finding actions a client has. Owns `aux_audits` and `aux_findings`
// (coding-standards.md §1 "one table, one owning service"). The WRITE side of
// both tables is the `crawl.audit` handler (NEW-C-9), which is where
// `resolved`, `regressed` and `stale` are set — never here.
//
// Tenancy: every query runs on the ambient context-carrying client; there is no
// workspace_id predicate anywhere below — RLS is the filter. The project scope
// predicate (`app.current_scope_projects()`) is the in-depth layer for a scoped
// manager or viewer, copied from TasksService.
//
// NOT HERE: `POST /aux-findings/{id}/create-task`. It needs the Track B
// task-insert helper (a finding-sourced task insert with the dedupe fingerprint
// and short_ref); until that lands, writing a second task-insert path here is
// the thing the plan forbids.

const SCOPE_OK = `(cardinality(app.current_scope_projects()) = 0 OR %P% = ANY(app.current_scope_projects()))`;

/** Statuses a client may acknowledge or will-not-fix from; `open` is acknowledged-only. */
const ACKNOWLEDGE_FROM: ReadonlySet<string> = new Set(["open", "regressed"]);
const WONT_FIX_FROM: ReadonlySet<string> = new Set(["open", "acknowledged", "in_progress", "regressed"]);

/** aux-and-geo-analysis.md §3: a will-not-fix finding is due back for review this many days after it was set. */
const WONT_FIX_RESURFACE_DAYS = 180;

const AUDIT_SELECT = `
  SELECT a.id, a.project_id, a.trigger, a.scope, a.status, a.started_at, a.finished_at, a.created_at,
         a.created_at::text AS created_at_key,
         a.pages_crawled, a.pages_failed, a.aux_score, a.score_capped, a.score_breakdown, a.rule_version,
         a.findings_critical, a.findings_high, a.findings_medium, a.findings_low,
         a.llms_txt_present, a.sitemap_url_count,
         COALESCE((
           SELECT jsonb_agg(jsonb_build_object('rule_code', x.code, 'title', COALESCE(r.title, x.code)) ORDER BY x.code)
             FROM unnest(a.excluded_rules) AS x(code)
             LEFT JOIN aux_rule_catalog r ON r.code = x.code
         ), '[]'::jsonb) AS excluded,
         (SELECT p.aux_score FROM aux_audits p
           WHERE p.project_id = a.project_id AND p.aux_score IS NOT NULL
             AND (p.created_at, p.id) < (a.created_at, a.id)
           ORDER BY p.created_at DESC, p.id DESC LIMIT 1) AS previous_score,
         ${SCOPE_OK.replace("%P%", "a.project_id")} AS in_scope
    FROM aux_audits a
    JOIN projects pr ON pr.id = a.project_id AND pr.deleted_at IS NULL`;

const FINDING_SELECT = `
  SELECT f.id, f.audit_id, f.project_id, f.rule_code, f.title, c.category, f.severity, f.status,
         c.rationale AS consequence, f.url, f.affected_pages, f.measured_value, f.threshold_value, f.evidence,
         COALESCE(c.auto_fixable, false) AS auto_fixable, f.requires_human_review, f.wont_fix_reason, f.wont_fix_at,
         f.first_detected_at, f.last_detected_at, f.resolved_at, f.regressed_at, f.occurrence_count, f.rule_version,
         (SELECT t.id FROM tasks t WHERE t.source_finding_id = f.id AND t.deleted_at IS NULL
           ORDER BY t.created_at DESC LIMIT 1) AS task_id,
         CASE f.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END AS severity_rank
    FROM aux_findings f
    LEFT JOIN aux_rule_catalog c ON c.code = f.rule_code`;

/** STORY-053: how many earlier patches a patch names. Patches are never deleted, so the read is bounded rather than the table. */
const EARLIER_PATCHES_MAX = 20;

const PATCH_SELECT = `
  SELECT p.id, p.finding_id, p.project_id, p.rule_code, p.kind, p.target_url, p.content_before_hash, p.content_after, p.unified_diff,
         p.jsonld_blocks, p.reversal, p.preconditions, p.explanation, p.derivation, p.requires_human_review, p.review_reason,
         p.risk_flags, p.created_at
    FROM patches p`;

@Injectable()
export class AuxService {
  private readonly logger = new Logger(AuxService.name);

  /** `GET /v1/aux-audits/{id}` — score and category breakdown. */
  async getAudit(auditId: string): Promise<AuxAudit> {
    const client = currentTenantStore()!.client;
    const result = await client.query<AuditRow>(`${AUDIT_SELECT} WHERE a.id = $1`, [auditId]);
    const row = result.rows[0];
    if (row === undefined) throw new NotFoundError({ message: "no such audit" });
    if (!row.in_scope) throw new ProjectOutOfScopeException();
    incrementCounter("nominara_aux_audit_reads_total", { route: "get" });
    return toAudit(row);
  }

  /** `GET /v1/projects/{id}/aux-audits` — newest first; `?limit=1` is "the latest audit". */
  async listProjectAudits(projectId: string, query: AuxAuditListQuery): Promise<Page<AuxAudit>> {
    const client = currentTenantStore()!.client;
    await this.assertProjectVisible(projectId);
    const after = query.cursor === undefined ? undefined : decodeCursor(query.cursor, "aux.audits", 2);
    const result = await client.query<AuditRow>(
      `${AUDIT_SELECT}
        WHERE a.project_id = $1
          AND ($2::timestamptz IS NULL OR (a.created_at, a.id) < ($2::timestamptz, $3::uuid))
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT $4`,
      [projectId, after?.[0] ?? null, after?.[1] ?? null, query.limit + 1],
    );
    incrementCounter("nominara_aux_audit_reads_total", { route: "list" });
    return pageFrom(result.rows, query.limit, "aux.audits", toAudit, (row) => [row.created_at_key, row.id]);
  }

  /** `GET /v1/projects/{id}/aux-findings` — filter by severity, status, rule, URL. */
  async listProjectFindings(projectId: string, query: AuxFindingListQuery): Promise<Page<AuxFinding>> {
    const client = currentTenantStore()!.client;
    await this.assertProjectVisible(projectId);
    const after = query.cursor === undefined ? undefined : decodeCursor(query.cursor, "aux.findings", 2);
    const result = await client.query<FindingRow>(
      `WITH items AS (${FINDING_SELECT}
         WHERE f.project_id = $1
           AND ($2::text IS NULL OR f.severity = $2::text)
           AND ($3::text IS NULL OR f.status = $3::text)
           AND ($4::text IS NULL OR f.rule_code = $4::text)
           AND ($5::text IS NULL OR f.url = $5::text))
       SELECT * FROM items
        WHERE $6::int IS NULL OR (severity_rank, id) > ($6::int, $7::uuid)
        ORDER BY severity_rank, id
        LIMIT $8`,
      [projectId, query.severity ?? null, query.status ?? null, query.rule_code ?? null, query.url ?? null, after?.[0] ?? null, after?.[1] ?? null, query.limit + 1],
    );
    incrementCounter("nominara_aux_finding_reads_total", { filtered: String(query.severity !== undefined || query.status !== undefined || query.rule_code !== undefined || query.url !== undefined) });
    const patches = await this.latestPatches(projectId, result.rows.slice(0, query.limit).map((r) => r.id));
    return pageFrom(result.rows, query.limit, "aux.findings", (row) => toFinding(row, patches.get(row.id) ?? null), (row) => [row.severity_rank, row.id]);
  }

  /**
   * `PATCH /v1/aux-findings/{id}` — acknowledge, re-open an acknowledged
   * finding, or mark will-not-fix with a reason.
   *
   * `resolved` is a 422 whatever the finding's state: it is earned by a later
   * audit that fails to reproduce the finding, never claimed. The only columns
   * this writes are `status` and `wont_fix_reason`, so no path here can touch
   * `resolved_at`, the severity, or the fingerprint.
   *
   * The row is locked FOR UPDATE: two concurrent PATCHes serialise and the loser
   * is judged against the winner's state.
   *
   * Moving to will-not-fix stamps `wont_fix_at` from the database clock (never a
   * client date); the read reports `resurfaces_at` 180 days later. The crawler's
   * re-detection never touches `wont_fix_at`. The automatic review transition on
   * a later audit belongs to the crawl.audit handler (STORY-052), not here.
   */
  async updateFinding(findingId: string, body: UpdateAuxFindingRequest): Promise<AuxFinding> {
    const store = currentTenantStore()!;
    const client = store.client;

    const found = await client.query<{ id: string; project_id: string; status: string; in_scope: boolean }>(
      `SELECT f.id, f.project_id, f.status, ${SCOPE_OK.replace("%P%", "f.project_id")} AS in_scope
         FROM aux_findings f
         JOIN projects p ON p.id = f.project_id AND p.deleted_at IS NULL
        WHERE f.id = $1
        FOR UPDATE OF f`,
      [findingId],
    );
    const current = found.rows[0];
    if (current === undefined) throw new NotFoundError({ message: "no such finding" });
    if (!current.in_scope) throw new ProjectOutOfScopeException();

    if (body.status === "resolved") {
      incrementCounter("nominara_aux_finding_actions_total", { action: "resolved", outcome: "refused" });
      throw new PreconditionUnmetError({ message: "a finding is resolved only by a later audit that does not reproduce it; no client can set it" });
    }

    const allowed =
      body.status === "acknowledged" ? ACKNOWLEDGE_FROM.has(current.status)
      : body.status === "open" ? current.status === "acknowledged"
      : WONT_FIX_FROM.has(current.status);
    if (!allowed) {
      incrementCounter("nominara_aux_finding_actions_total", { action: body.status, outcome: "conflict" });
      throw new ConflictError({ message: `a ${current.status} finding cannot be moved to ${body.status}`, details: { current_state: current.status } });
    }

    await client.query(`UPDATE aux_findings
          SET status = $2, wont_fix_reason = $3,
              wont_fix_at = CASE WHEN $2 = 'wont_fix' THEN now() ELSE NULL END
        WHERE id = $1`, [
      findingId,
      body.status,
      body.status === "wont_fix" ? body.reason : null,
    ]);

    incrementCounter("nominara_aux_finding_actions_total", { action: body.status, outcome: "applied" });
    // Workspace and finding IDs and the states only — never the reason text.
    this.logger.log({ message: "aux finding updated", workspace_id: store.context.workspaceId, finding_id: findingId, from: current.status, to: body.status });

    const read = await client.query<FindingRow>(`${FINDING_SELECT} WHERE f.id = $1`, [findingId]);
    const row = read.rows[0]!;
    return toFinding(row, (await this.latestPatches(row.project_id, [row.id])).get(row.id) ?? null);
  }

  /**
   * `GET /v1/patches/{id}` — one immutable patch, including one a later audit has since superseded (the artifact a customer
   * copied is always reconstructable). A permission denial is a 403, never a 404; a patch in another workspace is simply absent (RLS).
   */
  async getPatch(patchId: string): Promise<AuxPatch> {
    const client = currentTenantStore()!.client;
    const found = await client.query<PatchRow>(
      `${PATCH_SELECT}
        WHERE p.id = $1 AND EXISTS (SELECT 1 FROM projects pr WHERE pr.id = p.project_id AND pr.deleted_at IS NULL)`,
      [patchId],
    );
    const row = found.rows[0];
    if (row === undefined) throw new NotFoundError({ message: "no such patch" });
    const visible = await client.query(`SELECT 1 WHERE ${SCOPE_OK.replace("%P%", "$1::uuid")}`, [row.project_id]);
    if (visible.rows.length === 0) throw new ProjectOutOfScopeException();
    const audit = await this.latestAuditFacts(row.project_id);
    const earlier = await client.query<{ id: string }>(
      `SELECT id FROM patches WHERE finding_id = $1 AND (created_at, id) < ($2::timestamptz, $3::uuid)
        ORDER BY created_at DESC, id DESC LIMIT ${EARLIER_PATCHES_MAX}`,
      [row.finding_id, row.created_at, row.id],
    );
    incrementCounter("nominara_aux_patch_reads_total", { route: "get" });
    return toPatch(row, audit, row.finding_id === null ? [] : earlier.rows.map((r) => r.id));
  }

  /**
   * The newest patch of each finding, with the ids of the ones before it. One bounded query for the page (21 rows a finding at most), and
   * one for the project's latest audit, which is what `page_matches` is judged against.
   */
  private async latestPatches(projectId: string, findingIds: readonly string[]): Promise<Map<string, AuxPatch>> {
    const out = new Map<string, AuxPatch>();
    if (findingIds.length === 0) return out;
    const client = currentTenantStore()!.client;
    const rows = await client.query<PatchRow & { rn: number }>(
      `SELECT * FROM (
         SELECT p.*, row_number() OVER (PARTITION BY p.finding_id ORDER BY p.created_at DESC, p.id DESC) AS rn
           FROM (${PATCH_SELECT} WHERE p.finding_id = ANY($1::uuid[])) p
       ) ranked WHERE rn <= ${EARLIER_PATCHES_MAX + 1} ORDER BY finding_id, rn`,
      [findingIds],
    );
    if (rows.rows.length === 0) return out;
    const audit = await this.latestAuditFacts(projectId);
    const grouped = new Map<string, (PatchRow & { rn: number })[]>();
    for (const row of rows.rows) grouped.set(row.finding_id!, [...(grouped.get(row.finding_id!) ?? []), row]);
    for (const [findingId, list] of grouped) out.set(findingId, toPatch(list[0]!, audit, list.slice(1).map((r) => r.id)));
    incrementCounter("nominara_aux_patch_reads_total", { route: "finding" });
    return out;
  }

  /** What the project's most recent finished audit saw of the files a patch is judged against. null = no audit has finished. */
  private async latestAuditFacts(projectId: string): Promise<LatestAuditFacts | null> {
    const audit = await currentTenantStore()!.client.query<{ robots_hash: Buffer | null; llms_txt_present: boolean | null }>(
      `SELECT robots_hash, llms_txt_present FROM aux_audits
        WHERE project_id = $1 AND status IN ('completed', 'partial')
        ORDER BY created_at DESC, id DESC LIMIT 1`,
      [projectId],
    );
    const row = audit.rows[0];
    return row === undefined ? null : { robotsHash: row.robots_hash, llmsTxtPresent: row.llms_txt_present };
  }

  /** The project lookup is the 404: RLS and the scope predicate make a foreign or out-of-scope project simply absent. */
  private async assertProjectVisible(projectId: string): Promise<void> {
    const project = await currentTenantStore()!.client.query<{ id: string }>(
      `SELECT id FROM projects WHERE id = $1 AND deleted_at IS NULL AND ${SCOPE_OK.replace("%P%", "id")}`,
      [projectId],
    );
    if (project.rows.length === 0) throw new NotFoundError({ message: "no such project" });
  }
}

interface AuditRow {
  id: string;
  project_id: string;
  trigger: AuxAudit["trigger"];
  scope: AuxAudit["scope"];
  status: AuxAudit["status"];
  started_at: Date | null;
  finished_at: Date | null;
  created_at: Date;
  created_at_key: string;
  pages_crawled: number;
  pages_failed: number;
  aux_score: string | null;
  score_capped: boolean;
  score_breakdown: Record<string, unknown> | null;
  rule_version: string;
  findings_critical: number;
  findings_high: number;
  findings_medium: number;
  findings_low: number;
  llms_txt_present: boolean | null;
  sitemap_url_count: number | null;
  excluded: { rule_code: string; title: string }[];
  previous_score: string | null;
  in_scope: boolean;
}

interface FindingRow {
  id: string;
  audit_id: string;
  project_id: string;
  rule_code: string;
  title: string;
  category: AuxFinding["category"];
  severity: AuxFinding["severity"];
  status: AuxFinding["status"];
  consequence: string | null;
  url: string | null;
  affected_pages: number;
  measured_value: string | null;
  threshold_value: string | null;
  evidence: AuxFinding["evidence"];
  auto_fixable: boolean;
  requires_human_review: boolean;
  wont_fix_reason: string | null;
  wont_fix_at: Date | null;
  first_detected_at: Date;
  last_detected_at: Date;
  resolved_at: Date | null;
  regressed_at: Date | null;
  occurrence_count: number;
  rule_version: string;
  task_id: string | null;
  severity_rank: number;
}

interface PatchRow {
  id: string;
  finding_id: string | null;
  project_id: string;
  rule_code: string | null;
  kind: AuxPatch["kind"];
  target_url: string;
  content_before_hash: Buffer;
  content_after: string;
  unified_diff: string | null;
  jsonld_blocks: AuxPatch["jsonld_blocks"];
  reversal: AuxPatch["reversal"];
  preconditions: AuxPatch["preconditions"];
  explanation: string | null;
  derivation: string | null;
  requires_human_review: boolean;
  review_reason: string | null;
  risk_flags: string[];
  created_at: Date;
}

function toPatch(row: PatchRow, audit: LatestAuditFacts | null, earlier: string[]): AuxPatch {
  return {
    patch_id: row.id,
    finding_id: row.finding_id,
    project_id: row.project_id,
    rule_code: row.rule_code,
    kind: row.kind,
    target_url: row.target_url,
    content_before_hash: sha256Tag(row.content_before_hash),
    content_after: row.content_after,
    unified_diff: row.unified_diff,
    jsonld_blocks: row.jsonld_blocks,
    reversal: row.reversal,
    preconditions: row.preconditions,
    explanation: row.explanation,
    derivation: row.derivation,
    requires_human_review: row.requires_human_review,
    review_reason: row.review_reason,
    risk_flags: row.risk_flags,
    page_matches: pageMatches({ kind: row.kind, contentBeforeHash: row.content_before_hash, preconditions: row.preconditions }, audit),
    earlier_patch_ids: earlier,
    free: true,
    credits_charged: 0,
    created_at: row.created_at.toISOString(),
  };
}

/** `numeric` arrives as a string; null (not measured) stays null and "0" stays 0. */
const num = (value: string | null): number | null => (value === null ? null : Number(value));
const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

function toAudit(row: AuditRow): AuxAudit {
  const score = num(row.aux_score);
  const previous = num(row.previous_score);
  const breakdown = row.score_breakdown ?? {};
  return {
    audit_id: row.id,
    project_id: row.project_id,
    trigger: row.trigger,
    scope: row.scope,
    status: row.status,
    started_at: iso(row.started_at),
    completed_at: iso(row.finished_at),
    created_at: row.created_at.toISOString(),
    pages_crawled: row.pages_crawled,
    pages_failed: row.pages_failed,
    aux_score: score,
    capped: row.score_capped,
    delta: score === null || previous === null ? null : Math.round((score - previous) * 1000) / 1000,
    rule_version: row.rule_version,
    categories: AUX_CATEGORIES.flatMap((category) => {
      const subscore = breakdown[category];
      return typeof subscore === "number" ? [{ category, weight: AUX_CATEGORY_WEIGHTS[category], subscore }] : [];
    }),
    excluded_rules: row.excluded,
    findings: { critical: row.findings_critical, high: row.findings_high, medium: row.findings_medium, low: row.findings_low },
    llms_txt_present: row.llms_txt_present,
    sitemap_url_count: row.sitemap_url_count,
  };
}

function toFinding(row: FindingRow, patch: AuxPatch | null): AuxFinding {
  return {
    finding_id: row.id,
    audit_id: row.audit_id,
    project_id: row.project_id,
    rule_code: row.rule_code,
    title: row.title,
    category: row.category ?? null,
    severity: row.severity,
    status: row.status,
    consequence: row.consequence ?? null,
    url: row.url,
    affected_pages: row.affected_pages,
    measured_value: num(row.measured_value),
    threshold_value: num(row.threshold_value),
    evidence: row.evidence,
    auto_fixable: row.auto_fixable,
    requires_human_review: row.requires_human_review,
    wont_fix:
      row.status === "wont_fix" && row.wont_fix_reason !== null
        ? { reason: row.wont_fix_reason, resurfaces_at: row.wont_fix_at === null ? null : new Date(row.wont_fix_at.getTime() + WONT_FIX_RESURFACE_DAYS * 86_400_000).toISOString() }
        : null,
    first_detected_at: row.first_detected_at.toISOString(),
    last_detected_at: row.last_detected_at.toISOString(),
    resolved_at: iso(row.resolved_at),
    regressed_at: iso(row.regressed_at),
    occurrence_count: row.occurrence_count,
    rule_version: row.rule_version,
    task_id: row.task_id,
    patch,
    // A rule with no patch carries structured guidance and an alignment link instead (STORY-053 AC9).
    guidance: patch === null ? guidanceFor(row.rule_code, { projectId: row.project_id, url: row.url }) : null,
  };
}
