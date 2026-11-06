import { createHash } from "node:crypto";
import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { ClientBase, Pool } from "pg";
import { z } from "zod";
import { AUX_CATEGORY_WEIGHTS } from "../../lib/scoring/aux.js";
import type {
  AuxAudit,
  AuxAuditListQuery,
  AuxFinding,
  AuxFindingListQuery,
  TriggerAuxAuditPreviewResponse,
  TriggerAuxAuditRequest,
  TriggerAuxAuditResponse,
  UpdateAuxFindingRequest,
} from "../../../contracts/aux/index.js";
import { AUX_CATEGORIES } from "../../../contracts/aux/index.js";
import { patchJsonldBlockSchema, patchPreconditionSchema, patchReversalSchema, patchRiskFlagSchema } from "../../../contracts/aux/index.js";
import type { AuxPatch } from "../../../contracts/aux/index.js";
import { guidanceFor } from "../../lib/aux/patches/guidance.js";
import { pageMatches, sha256Tag, type LatestAuditFacts } from "../../lib/aux/patches/precondition.js";
import { failManualAudit } from "../../lib/aux/fail-manual-audit.js";
import { ConflictError, FeatureNotInPlanError, IdempotencyConflictError, NotFoundError, PreconditionUnmetError, PriceChangedError, UnauthenticatedError, ValidationFailedError } from "../../api/errors/domain-errors.js";
import { PG_POOL } from "../../db/pg-pool.js";
import { AUX_AUDIT_RULE_VERSION, AUX_AUDIT_TOKENIZER } from "../../lib/aux/audit-constants.js";
import { AUX_AUDIT_BASE_CREDITS, AUX_AUDIT_BASE_PAGES, AUX_AUDIT_EXTRA_PAGE_CREDITS, auxAuditPrice, auxAuditPricing } from "../../lib/aux/audit-price.js";
import { IDEMPOTENCY_REPLAY_WINDOW_HOURS, manualAuditIdentity, type ManualAuditIdentity } from "../../lib/aux/manual-audit-id.js";
import { AUX_AUDITS_ENTITLEMENT, auxAuditsIncluded, crawlAuditIdempotencyKey } from "../../lib/aux/onboarding-audit.js";
import { pageCapForPlan } from "../../lib/aux/page-selection.js";
import { autoTopupEnqueuerFor } from "../../lib/credits/auto-topup-request.js";
import { AUX_AUDIT_REFERENCE } from "../../lib/credits/aux-audit-refund.js";
import { parseConfirmedCredits, requireConfirmedCredits } from "../../lib/credits/confirmed-credits.js";
import { debitInTransaction, includedGrantOf } from "../../lib/credits/debit.js";
import { resolveEntitlements } from "../../lib/entitlements/resolution.js";
import { acquireAdvisoryXactLock } from "../../lib/queue/locks.js";
import { QueueProducer } from "../../lib/queue/queue-producer.js";
import { SYSTEM_ACTOR_ID } from "../../tenancy/constants.js";
import { decodeCursor } from "../../api/pagination/cursor.js";
import { Page, pageFrom } from "../../api/pagination/page.js";
import { findingView } from "../../lib/aux/finding-view.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { ProjectOutOfScopeException } from "../../tenancy/errors.js";
import { afterCommit, currentTenantStore, withTenantContext } from "../../tenancy/tenant-context.js";

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
         -- per category, the catalog rules this audit did NOT run: a subscore over a category with a rule missing is not a full measurement
         COALESCE((
           SELECT jsonb_object_agg(g.category, g.codes)
             FROM (SELECT c.category, jsonb_agg(c.code ORDER BY c.code) AS codes
                     FROM aux_rule_catalog c WHERE c.code = ANY(a.excluded_rules) GROUP BY c.category) g
         ), '{}'::jsonb) AS excluded_by_category,
         a.excluded_rules AS excluded_codes,
         prev.aux_score AS previous_score, prev.rule_version AS previous_rule_version, prev.excluded_rules AS previous_excluded_codes,
         ${SCOPE_OK.replace("%P%", "a.project_id")} AS in_scope
    FROM aux_audits a
    JOIN projects pr ON pr.id = a.project_id AND pr.deleted_at IS NULL
    -- the previous SCORED audit: its score, and how it was measured (rule version, unmeasured rules), so a delta is only shown between like audits
    LEFT JOIN LATERAL (
      SELECT p.aux_score, p.rule_version, p.excluded_rules FROM aux_audits p
       WHERE p.project_id = a.project_id AND p.aux_score IS NOT NULL
         AND (p.created_at, p.id) < (a.created_at, a.id)
       ORDER BY p.created_at DESC, p.id DESC LIMIT 1
    ) prev ON true`;

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

const manualAuditLogger = new Logger("aux.manual-audit");
const tracer = trace.getTracer("nominara-api");

@Injectable()
export class AuxService {
  // Both optional so the read side stays constructible with no arguments (aux.spec.ts); `triggerAudit` refuses, before charging anything, when either is absent.
  constructor(
    @Optional() @Inject(PG_POOL) private readonly pool?: Pool,
    @Optional() private readonly queues?: QueueProducer,
  ) {}

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
    for (const [findingId, list] of grouped) {
      const patch = toPatch(list[0]!, audit, list.slice(1).map((r) => r.id));
      // A latest patch made against a file that has since changed is not offered on the finding: the audit would have made a new one, so
      // its absence means today's gate refused or found nothing. It stays readable by id.
      if (patch.page_matches !== false) out.set(findingId, patch);
    }
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

  /**
   * `POST /projects/{id}/aux-audits/preview` (owner decision 39) - the QUOTE half of the priced-action flow: what a manual audit of this project would
   * debit now, and how the figure was reached. Free and read-only: no reservation, no ledger entry, no audit row, no job. Refused exactly as the trigger is
   * (404 for a project that is not the caller's, 403 `feature_not_in_plan`), so a quote is never shown for an action that would be refused.
   */
  async previewAudit(projectId: string, body: TriggerAuxAuditRequest): Promise<TriggerAuxAuditPreviewResponse> {
    const store = currentTenantStore();
    if (store === undefined) throw new Error("AuxService.previewAudit requires an active tenant context");
    await this.assertProjectVisible(projectId);
    const quote = await this.quoteFor(store.client as ClientBase, store.context.workspaceId, projectId, body);
    incrementCounter("nominara_aux_manual_audit_previews_total", {});
    return { credits: quote.credits, requested_scope: quote.scope, pricing: auxAuditPricing(quote.pages), credits_charged: 0 };
  }

  /**
   * `POST /projects/{id}/aux-audits` - the manual re-audit (STORY-194; owner decisions 34 item 3, 39). The ONE priced AUX trigger: scheduled, onboarding and
   * post-fix audits are 0 credits and never come through here.
   *
   * ONE TRANSACTION, the request's: the plan check, the price check, the debit (reserve and commit under the wallet lock, so a 402 rolls everything back and a
   * refused request leaves no audit, no ledger entry and no job) and the queued audit row. The job is enqueued only AFTER COMMIT (KAD-06): a rollback never
   * leaves a job for an audit that does not exist, and no transaction is held across the queue.
   *
   * IDENTITY IS THE CALLER'S IDEMPOTENCY KEY. The audit id and the ledger key are derived from (workspace, user, project, `Idempotency-Key`), so a replay is refused by the
   * DATABASE - `ux_credit_ledger_idem`, the `aux_audits` primary key - whatever the Valkey `IdempotencyInterceptor` still holds (it fails open by design: allkeys-lru).
   * A transaction-scoped advisory lock on that identity makes a concurrent retry wait for the first attempt and then read its answer. A replay returns the
   * audit that already exists and charges nothing; the same key with a different body is `409 idempotency_conflict`.
   *
   * PRICE CONFIRMATION (api-specification.md sections 1 and 7): `X-Nominara-Confirmed-Credits` is REQUIRED and must equal the price recomputed here, or
   * nothing is charged - 400 when absent, `409 price_changed` (shown, recomputed, reason) when it differs - all BEFORE `debitInTransaction`. A replay is
   * answered before that check: a retry of a request that succeeded must not turn into `price_changed` because a price moved since.
   *
   * PRICE: the plan's page cap, or 1 page for a single-URL audit (FR-TL-03: 10 credits for up to 25 pages, +1 per page after). The cap is PROVISIONAL
   * (page-selection.ts), so today every plan pays the first band's flat 10; `audit-price.test.ts` pins that. Verification decides scope, not price. A partial audit is charged in full; an audit
   * that delivers nothing is refunded in full - by `crawl.audit` (no site file reachable, project gone, last attempt failed), here (the job could not be queued), or the 60-minute reaper.
   */
  async triggerAudit(
    projectId: string,
    body: TriggerAuxAuditRequest,
    actor: { readonly id: string | null; readonly type: "user" | "api_key" | "system" },
    options: { readonly idempotencyKey: string | undefined; readonly confirmedCredits: string | readonly string[] | undefined },
  ): Promise<TriggerAuxAuditResponse> {
    const store = currentTenantStore();
    if (store === undefined) throw new Error("AuxService.triggerAudit requires an active tenant context");
    // Fail closed BEFORE anything is charged: a process built without the queue cannot run the audit it would be charging for.
    const { pool, queues } = this;
    if (pool === undefined || queues === undefined) throw new Error("AuxService.triggerAudit needs the pg pool and the queue producer");
    const tx = store.client as ClientBase;
    const workspaceId = store.context.workspaceId;
    // A malformed header is a 400 before any row is read; whether one is REQUIRED is decided from the recomputed price.
    const confirmed = parseConfirmedCredits(options.confirmedCredits);
    // The identity is scoped by the actor (review round 5), as the Idempotency interceptor's record is by the user; without one there is nothing to scope by, so fail
    // closed rather than let every actor-less caller share one identity.
    const actorId = actor.id;
    if (actorId === null) throw new UnauthenticatedError({ message: "An authenticated user is required to start an audit" });
    const clientKey = options.idempotencyKey;
    if (clientKey === undefined || clientKey.length === 0 || clientKey.length > 255) {
      throw new ValidationFailedError({
        message: "idempotency-key is required on this route and must be 1-255 characters",
        details: { issues: [{ path: ["idempotency-key"], message: "required" }] },
      });
    }

    return tracer.startActiveSpan("aux.audit.trigger", async (span) => {
      try {
        await this.assertProjectVisible(projectId);
        // Serialise attempts that share a client key (every generation of it): the second waits for the first to commit, then finds its audit below.
        await acquireAdvisoryXactLock(tx, [AUX_AUDIT_REFERENCE, manualAuditIdentity(workspaceId, actorId, projectId, clientKey).auditId].join(":"));
        // OWNER DECISION 48: walk the key's generations. One whose audit is inside the 24-hour window is REPLAYED; one past it is skipped (the key has outlived
        // it); the first with no audit is where a new one is made. Each skipped generation is a full window old, so the walk is as long as the key's age in days.
        let generation = 0;
        let identity = manualAuditIdentity(workspaceId, actorId, projectId, clientKey, generation);
        for (;;) {
          const replay = await this.replayOf(tx, identity, workspaceId, actorId, clientKey, projectId, body);
          if (replay === null) break;
          if (replay !== "expired") {
            incrementCounter("nominara_aux_manual_audits_requested_total", { outcome: "replayed" });
            span.setAttribute("nominara.aux.replayed", true);
            return replay;
          }
          generation += 1;
          identity = manualAuditIdentity(workspaceId, actorId, projectId, clientKey, generation);
        }
        const { auditId, ledgerKey } = identity;

        const quote = await this.quoteFor(tx, workspaceId, projectId, body);
        const shown = requireConfirmedCredits(confirmed);
        if (shown !== quote.credits) {
          incrementCounter("nominara_aux_manual_audits_requested_total", { outcome: "price_changed" });
          throw new PriceChangedError({
            message: "the confirmed price does not match this action's current price",
            // BOTH FIGURES, so a client can tell whether to re-quote or give up.
            details: { shown, recomputed: quote.credits, reason: `a ${quote.scope} AUX audit of ${String(quote.pages)} page(s) resolved to ${String(quote.credits)} credits for this workspace` },
          });
        }

        await debitInTransaction(tx, {
          workspaceId,
          actorId: actor.id,
          actorType: actor.type,
          actionCode: "aux_manual",
          credits: quote.credits,
          idempotencyKey: ledgerKey,
          projectId,
          referenceType: AUX_AUDIT_REFERENCE,
          referenceId: auditId,
          includedGrant: includedGrantOf(quote.entitlements),
          ...(autoTopupEnqueuerFor(queues) === undefined ? {} : { autoTopup: autoTopupEnqueuerFor(queues)! }),
        });

        await tx.query(
          `INSERT INTO aux_audits (id, workspace_id, project_id, trigger, triggered_by, scope, target_urls, rule_version, tokenizer, status, request_hash)
           VALUES ($1, $2, $3, 'manual', $4, $5, $6, $7, $8, 'queued', $9)`,
          [auditId, workspaceId, projectId, actor.type === "user" ? actor.id : null, quote.scope, body.target_urls ?? [], AUX_AUDIT_RULE_VERSION, AUX_AUDIT_TOKENIZER, requestHashOf(actorId, projectId, body)],
        );

        afterCommit(() => {
          void queues
            .enqueueTenantJob(
              "crawl.audit",
              workspaceId,
              { projectId, auditId, trigger: "manual", scope: quote.scope, ...(body.target_urls === undefined ? {} : { targetUrls: body.target_urls }) },
              { idempotencyKey: crawlAuditIdempotencyKey(projectId, auditId) },
            )
            .catch((error: unknown) => {
              incrementCounter("nominara_aux_manual_audits_requested_total", { outcome: "dispatch_failed" });
              // The error NAME only: a queue error's message can carry a connection string.
              manualAuditLogger.error({
                event: "aux.manual_audit.dispatch_failed",
                workspace_id: workspaceId,
                project_id: projectId,
                audit_id: auditId,
                error: error instanceof Error ? error.name : "unknown",
              });
              return this.failUndispatchedAudit(pool, workspaceId, auditId).catch((compensationError: unknown) => {
                manualAuditLogger.error({
                  event: "aux.manual_audit.compensation_failed",
                  workspace_id: workspaceId,
                  audit_id: auditId,
                  error: compensationError instanceof Error ? compensationError.name : "unknown",
                });
              });
            });
        });

        incrementCounter("nominara_aux_manual_audits_requested_total", { outcome: "queued" });
        // IDs and the figure only: never the domain, the workspace's name or a target URL.
        manualAuditLogger.log({ event: "aux.manual_audit.requested", workspace_id: workspaceId, project_id: projectId, audit_id: auditId, scope: quote.scope, credits: quote.credits });
        span.setAttribute("nominara.aux.credits", quote.credits);
        return { audit_id: auditId, status: "queued" as const, trigger: "manual" as const, requested_scope: quote.scope, credits_charged: quote.credits, credits_refunded: 0, pricing: auxAuditPricing(quote.pages) };
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  /** The plan check and the price, shared by the quote and the charge so they can never disagree. Throws 404 (no such project) and 403 `feature_not_in_plan`. */
  private async quoteFor(
    tx: ClientBase,
    workspaceId: string,
    projectId: string,
    body: TriggerAuxAuditRequest,
  ): Promise<{ readonly scope: NonNullable<TriggerAuxAuditRequest["scope"]>; readonly pages: number; readonly credits: number; readonly entitlements: Awaited<ReturnType<typeof resolveEntitlements>>["entitlements"] }> {
    const plan = await tx.query<{ plan_key: string }>(
      "SELECT w.plan_key FROM projects p JOIN workspaces w ON w.id = p.workspace_id WHERE p.id = $1 AND p.deleted_at IS NULL",
      [projectId],
    );
    const planKey = plan.rows[0]?.plan_key;
    if (planKey === undefined) throw new NotFoundError({ message: "no such project" });

    const resolved = await resolveEntitlements(tx, workspaceId);
    if (!auxAuditsIncluded(resolved.entitlements)) {
      incrementCounter("nominara_aux_manual_audits_requested_total", { outcome: "feature_not_in_plan" });
      const lowest = await tx.query<{ key: string }>(
        `SELECT key FROM plans WHERE (entitlements -> $1 -> 'value') NOT IN ('false'::jsonb, 'null'::jsonb) ORDER BY sort_order ASC LIMIT 1`,
        [AUX_AUDITS_ENTITLEMENT],
      );
      throw new FeatureNotInPlanError({
        message: "AUX audits are not included in this plan",
        details: { key: AUX_AUDITS_ENTITLEMENT, min_plan: lowest.rows[0]?.key ?? "unknown" },
      });
    }

    const scope = body.scope ?? "key_pages";
    const pages = scope === "single_url" ? 1 : pageCapForPlan(planKey);
    return { scope, pages, credits: auxAuditPrice(pages), entitlements: resolved.entitlements };
  }

  /**
   * The answer to a request whose identity already has an audit: the audit that was made, with the figure the ledger actually took. `null` when there is none
   * (a first attempt), and `"expired"` when there is one but it was requested more than 24 hours ago (owner decision 48): the key has outlived its window, so
   * the caller moves to the key's next generation. Inside the window, the same identity asked for something else (another project, scope or URL list) is a conflict, never a quiet return of the wrong audit.
   */
  private async replayOf(
    tx: ClientBase,
    identity: ManualAuditIdentity,
    workspaceId: string,
    actorId: string,
    clientKey: string,
    projectId: string,
    body: TriggerAuxAuditRequest,
  ): Promise<TriggerAuxAuditResponse | "expired" | null> {
    const auditId = identity.auditId;
    // The request is compared with request_hash, written once at insert: scope and target_urls are REWRITTEN by crawl.audit (verification decides the scope; the
    // crawled pages replace the hints), so they cannot say what was asked. The status and the refunds are read live: a replay reports where the audit has got to.
    const found = await tx.query<{ request_hash: string | null; scope: NonNullable<TriggerAuxAuditRequest["scope"]>; status: TriggerAuxAuditResponse["status"]; created_at: Date; expired: boolean; charged: string | null; refunded: string }>(
      `SELECT a.request_hash, a.scope, a.status, a.created_at, (a.created_at <= now() - make_interval(hours => $3)) AS expired,
              (SELECT l.credits::text FROM credit_ledger l WHERE l.entry_type = 'commit' AND l.reference_type = $2 AND l.reference_id = a.id ORDER BY l.seq DESC LIMIT 1) AS charged,
              (SELECT COALESCE(SUM(l.credits), 0)::text FROM credit_ledger l WHERE l.entry_type = 'refund' AND l.reference_type = $2 AND l.reference_id = a.id) AS refunded
         FROM aux_audits a WHERE a.id = $1`,
      [auditId, AUX_AUDIT_REFERENCE, IDEMPOTENCY_REPLAY_WINDOW_HOURS],
    );
    const row = found.rows[0];
    if (row === undefined) {
      // No audit row, but the generation's ledger entry may outlive it: only a direct delete of the audit row reaches this (a project is soft-deleted, so it no longer cascades `aux_audits`), and the append-only ledger keeps the charge. Taking
      // this generation again would run into its ledger key (500), so an entry older than the window means the generation is spent - expired, the walk moves on.
      // The age is the ledger entry's own (the first one this identity wrote), on the database clock.
      const spent = await tx.query<{ expired: boolean }>(
        `SELECT (min(occurred_at) <= now() - make_interval(hours => $3)) AS expired FROM credit_ledger WHERE workspace_id = $1 AND idempotency_key = $2 HAVING count(*) > 0`,
        [workspaceId, identity.ledgerKey, IDEMPOTENCY_REPLAY_WINDOW_HOURS],
      );
      return spent.rows[0]?.expired === true ? "expired" : null;
    }
    // Past the window the key means nothing for this audit: not a replay and not a conflict (a different body is a new request, as on every paid action).
    if (row.expired) return "expired";
    if (row.request_hash !== requestHashOf(actorId, projectId, body)) {
      throw new IdempotencyConflictError({
        message: "this Idempotency-Key was already used for a different AUX audit request",
        // Hashes and a time only: never the key, the project or a URL.
        details: {
          key_hash: createHash("sha256").update(clientKey).digest("hex"),
          original_request_hash: row.request_hash ?? "unrecorded",
          original_recorded_at: row.created_at.toISOString(),
        },
      });
    }
    const charged = row.charged === null ? null : Number(row.charged);
    if (charged === null || !Number.isInteger(charged) || charged < 1) throw new Error(`manual audit ${auditId} exists without a recorded charge`);
    // The page count the figure was reached with: beyond the first band it is exact; inside it, a single-URL audit priced 1 page and any other the (clamped) cap.
    // The REQUESTED scope is not on the row any more (crawl.audit rewrites `scope`), so it is the body's - which the hash has just proved is the original's.
    const requested = body.scope ?? "key_pages";
    const pages = charged > AUX_AUDIT_BASE_CREDITS ? AUX_AUDIT_BASE_PAGES + (charged - AUX_AUDIT_BASE_CREDITS) / AUX_AUDIT_EXTRA_PAGE_CREDITS : requested === "single_url" ? 1 : AUX_AUDIT_BASE_PAGES;
    return { audit_id: auditId, status: row.status, trigger: "manual", requested_scope: requested, credits_charged: charged, credits_refunded: Number(row.refunded), pricing: auxAuditPricing(pages) };
  }

  /**
   * The audit was charged and queued, but the job never reached the queue, so it will never run: fail the row and give the charge back, in a fresh
   * tenant transaction (the request's has committed). Only a row still `queued` is failed, so this cannot undo an audit that did start.
   */
  private async failUndispatchedAudit(pool: Pool, workspaceId: string, auditId: string): Promise<void> {
    const client = await pool.connect();
    try {
      await withTenantContext(client, { workspaceId, actorId: SYSTEM_ACTOR_ID }, async (tx) => {
        // The one failure function (aux/fail-manual-audit.ts): only a still-queued or running manual audit moves, the refund follows the row, the counter moves.
        await failManualAudit(tx, { workspaceId, auditId, reason: "dispatch_failed" });
      });
    } finally {
      client.release();
    }
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

/** The immutable record of a manual audit request: actor, project, the scope asked for (absent = key_pages) and the URL hints, in the order sent. */
function requestHashOf(actorId: string, projectId: string, body: TriggerAuxAuditRequest): string {
  return createHash("sha256").update(JSON.stringify([actorId, projectId, body.scope ?? "key_pages", body.target_urls ?? []])).digest("hex");
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
  excluded_by_category: Record<string, string[]>;
  previous_score: string | null;
  /** How the previous scored audit was measured: a delta is shown only between audits measured the same way (owner decision 52). */
  previous_rule_version: string | null;
  excluded_codes: string[];
  previous_excluded_codes: string[] | null;
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
    jsonld_blocks: row.jsonld_blocks === null ? null : z.array(patchJsonldBlockSchema).parse(row.jsonld_blocks),
    reversal: row.reversal === null ? null : patchReversalSchema.parse(row.reversal),
    preconditions: z.array(patchPreconditionSchema).parse(row.preconditions),
    explanation: row.explanation,
    derivation: row.derivation,
    requires_human_review: row.requires_human_review,
    review_reason: row.review_reason,
    risk_flags: z.array(patchRiskFlagSchema).parse(row.risk_flags),
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
  const unmeasured = AUX_CATEGORIES.filter((category) => typeof breakdown[category] !== "number");
  // Owner decision 52: a published category that lists a rule it did not run was scored on the rules that WERE decided - not a full measurement either.
  const rulesUnmeasured = Object.values(row.excluded_by_category).some((codes) => codes.length > 0);
  // Two scores are comparable only when they were measured the same way: the same rule version and the same set of unmeasured rules.
  const sameBasis =
    previous !== null &&
    row.previous_rule_version === row.rule_version &&
    row.previous_excluded_codes !== null &&
    [...row.excluded_codes].sort().join(",") === [...row.previous_excluded_codes].sort().join(",");
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
    // Owner decisions 38 and 52: the headline is over the rules that were decided, so it is labelled partial whenever a category is missing OR a rule went
    // unmeasured inside a published one. A null score is not partial.
    score_partial: score !== null && (unmeasured.length > 0 || rulesUnmeasured),
    unmeasured_categories: unmeasured,
    capped: row.score_capped,
    // null when either score is absent, and null across audits measured differently (a rule-version bump, or a different set of unmeasured rules): that gap is the
    // measurement changing, not the site. 0 stays 0.
    delta: score === null || previous === null || !sameBasis ? null : Math.round((score - previous) * 1000) / 1000,
    rule_version: row.rule_version,
    categories: AUX_CATEGORIES.flatMap((category) => {
      const subscore = breakdown[category];
      return typeof subscore === "number" ? [{ category, weight: AUX_CATEGORY_WEIGHTS[category], subscore, rules_not_evaluated: row.excluded_by_category[category] ?? [] }] : [];
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
    // STORY-082 AC8: the consequence-first fields are shaped by the renderer the AUX audit tool shares.
    ...findingView({
      consequence: row.consequence ?? null,
      title: row.title,
      rule_code: row.rule_code,
      category: row.category ?? null,
      severity: row.severity,
      url: row.url,
      affected_pages: row.affected_pages,
      measured_value: num(row.measured_value),
      threshold_value: num(row.threshold_value),
      evidence: row.evidence,
      auto_fixable: row.auto_fixable,
      requires_human_review: row.requires_human_review,
    }),
    status: row.status,
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
