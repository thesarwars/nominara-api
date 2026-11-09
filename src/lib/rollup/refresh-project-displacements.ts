import { Logger } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { ClientBase } from "pg";
import {
  citationGapSchema,
  conceptGapSchema,
  displacedBySchema,
  type CitationGapEntry,
  type ConceptGapEntry,
} from "../../../contracts/analytics/displacement-event.schema.js";
import {
  detectDisplacement,
  restoresSlot,
  type CaptureSnapshot,
  type DetectedDisplacement,
  type SnapshotCitation,
  type SnapshotEntity,
} from "../analytics/displacement.js";
import { deriveConceptGap, type ConceptCandidate } from "../analytics/concept-gap.js";
import { isLowConfidence, suppressRecommendations } from "../geo/corpus/weights.js";
import { classifyDomain } from "../parser/citation-url.js";
import { displacementImpactForEvent, type FunnelStage } from "../scoring/displacement-impact.js";
import { lockNodeScopesShared } from "../geo/alignment/scope-lock.js";
import { SCORING_VERSION } from "../scoring/index.js";
import { incrementCounter, observeValue } from "../telemetry/metrics.js";
import { datesWithFacts, measurementStatusSql } from "./aggregate-day.js";
import { afterCommit, currentTenantStore } from "../../tenancy/tenant-context.js";

// NEW-C-3 / STORY-056 AC1/3/5/8/9/10 + STORY-057 AC1/2/10 — persists
// `displacement_events` on the rollup path.
//
// For every capture a workspace-local day contains, the PREVIOUS capture of the
// same prompt + engine (with a known brand outcome) is its baseline. Captures
// are walked in time order; each first tries to RECOVER the cell's open events,
// then to open new ones. Idempotent: the unique key over the capture pair
// (`ux_displacement_cell`) makes a re-run or a dirty-date reprocess an UPDATE of
// the computed columns — `detected_at`, `acknowledged_at`, `task_id` and
// `recovered_at` are never touched by it.
//
// `citation_gap` is read ONLY from `citation_facts` slots on the after-capture.
// A slot is attributed to a displacing entity only when it is a tracked
// competitor whose `root_domain` the slot's domain matches. There is no stored
// link from an UNTRACKED entity to a slot, so none is guessed: its gap is empty.
// `concept_gap` (STORY-057 AC4/AC5/AC10) comes from the prompt's cluster's JUDGED semantic nodes (`loadConceptNodes`): at or above the
// prevalence threshold, absent from the page, evidenced by a source the displacers cited, thin-corpus suppressed. It is written when the event is first stored and never
// replaced once non-empty, so a returning customer sees the same diagnosis (an empty gap is filled by a later run, once a corpus exists).
//
// A recovery that follows a COMPLETED task (ANY task reachable from the event — its linked
// `task_id` (the plan's first task, or a deduped task shared from another displacement) or a task
// with `source_displacement_id` = the event — is `done`, not deleted, with `completed_at`
// strictly before `recovered_at`) pins a
// `displacement_recovered` milestone at the recovery instant (STORY-056 AC9).
// It is keyed `(system, event id)`, so a re-run can never pin it twice.
//
// Detection lag (AC11): the first insert of an event observes
// `detected_at - after.captured_at` in seconds; a re-run only updates, so it does
// not observe again. A backfill (the demo seed) never observes: its events are written
// days after their captures and would skew the SLO p95. The observation measures the lag;
// the p95 objective itself is proven by the production histogram, not by a test.
//
// NOT HERE: STORY-056 scenario 13 (the no-cooldown high-impact alert) belongs to
// STORY-068's alert catalog (owner decision 2026-10-27) — no second alert path.

const logger = new Logger("refresh-project-displacements");
const tracer = trace.getTracer("nominara.displacement");
const LAG_METRIC = "nominara_rollup_displacement_detection_lag_seconds";

const RECOVERY_TITLE: Readonly<Record<DetectedDisplacement["kind"], string>> = {
  presence_lost: "Displacement recovered: brand presence restored",
  position_lost: "Displacement recovered: position restored",
  recommendation_lost: "Displacement recovered: recommendation restored",
  render_downgraded: "Displacement recovered: render form restored",
};

interface CaptureRow {
  id: string;
  prompt_id: string;
  engine_key: string;
  captured_at: string;
  brand_present: boolean;
  brand_rank_position: number | null;
}

interface CellContext {
  readonly funnelStage: FunnelStage;
  readonly topicRankByIntent: number;
  readonly engineWeight: number;
  readonly maxEngineWeight: number;
}

const CLASS_ORDER = ["recommendation", "ranked", "neutral_list", "also_consider", "caveat"];

/**
 * Owner decision 57a - a refused or empty answer counts as "not mentioned" in presence, but it is NO OBSERVATION for displacement: it
 * never opens an event, never closes one, and is never the baseline of the next comparison (the brand was not lost, the engine said
 * nothing). Excludes rows flagged `engine_refused_to_answer` or `empty_answer` (a reused row carries its source's resolution on its own
 * flags) and rows whose own payload text is empty after trim. No subquery. `table` is a fixed identifier, never user input.
 */
function observedAnswerSql(table: string): string {
  // THE FLAGS DECIDE. capture.parse stamps `empty_answer` on every row it resolves as an empty answer (live or reused, and by the same
  // JS definition of blank as the parser: String.trim, which includes U+FEFF and U+00A0), so the detector reads only the row's OWN columns:
  // no subquery, no change of meaning when retention drops a source. The text test is a FALLBACK for legacy rows written before the stamp
  // existed; it spells out JS's blank set because Postgres `\s` does not match U+FEFF. A row with no text (an L2 row, payload {}) is
  // not excluded by its text.
  return `NOT (${table}.flags && ARRAY['engine_refused_to_answer', 'empty_answer']::text[])
          AND (${table}.payload->>'text' IS NULL OR ${table}.payload->>'text' !~ '^[\\s\\u00a0\\ufeff\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]*$')`;
}

export async function refreshProjectDisplacements(
  tx: ClientBase,
  projectId: string,
  date: string,
  timezone: string,
  options: { readonly observeLag?: boolean; readonly scopesLocked?: boolean } = {},
): Promise<number> {
  return tracer.startActiveSpan("displacement.refresh", async (span) => {
    try {
      const lags: number[] = [];
      const persisted = await refreshProjectDisplacementsInner(tx, projectId, date, timezone, options.observeLag ?? true, lags, options.scopesLocked ?? false);
      emitLagObservations(lags);
      span.setAttribute("nominara.project_id", projectId);
      span.setAttribute("nominara.displacement.events", persisted);
      return persisted;
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}

/**
 * Lag observations are emitted AFTER the rollup transaction commits, so a retry of a rolled-back transaction
 * (which inserts the event again) never double-counts. With no ambient tenant transaction (a direct call) there is
 * no commit to wait for and they are emitted at once. `detected_at` is the transaction's start (`now()`), so the
 * observed lag is a lower bound by up to the transaction's length (seconds against a 20-minute objective).
 */
function emitLagObservations(lags: readonly number[]): void {
  if (lags.length === 0) return;
  const emit = (): void => {
    for (const lag of lags) observeValue(LAG_METRIC, lag, { outcome: "ok" });
  };
  if (currentTenantStore() !== undefined) afterCommit(emit);
  else emit();
}

async function refreshProjectDisplacementsInner(
  tx: ClientBase,
  projectId: string,
  date: string,
  timezone: string,
  observeLag: boolean,
  lags: number[],
  scopesLocked: boolean,
): Promise<number> {
  const project = await tx.query<{ workspace_id: string }>(`SELECT workspace_id FROM projects WHERE id = $1`, [projectId]);
  const workspaceId = project.rows[0]?.workspace_id;
  if (workspaceId === undefined) return 0; // not visible to this tenant context

  const captures = (
    await tx.query<CaptureRow>(
      `SELECT id, prompt_id, engine_key, captured_at::text AS captured_at, brand_present, brand_rank_position
         FROM answer_captures
        WHERE project_id = $1 AND sample_index = 0 AND brand_present IS NOT NULL
          AND (captured_at AT TIME ZONE $2)::date = $3::date
          AND ${measurementStatusSql("status")}
          AND ${observedAnswerSql("answer_captures")}
        ORDER BY captured_at, id`,
      [projectId, timezone, date],
    )
  ).rows;
  if (captures.length === 0) return 0;
  // The concept read needs every cluster's scope quiet: take the shared locks once, up front, in the embed handler's order.
  if (!scopesLocked) await lockProjectNodeScopes(tx, workspaceId, projectId);

  const competitorDomains = new Map(
    (
      await tx.query<{ id: string; root_domain: string | null }>(
        `SELECT id, root_domain FROM competitors WHERE project_id = $1 AND deleted_at IS NULL`,
        [projectId],
      )
    ).rows.map((r) => [r.id, r.root_domain]),
  );
  const maxEngineWeight = Number(
    (await tx.query<{ w: number | null }>(`SELECT max(weight)::float8 AS w FROM project_engines WHERE project_id = $1 AND enabled`, [projectId])).rows[0]?.w ?? 0,
  );

  let persisted = 0;
  for (const after of captures) {
    const beforeRow = (
      await tx.query<CaptureRow>(
        `SELECT id, prompt_id, engine_key, captured_at::text AS captured_at, brand_present, brand_rank_position
           FROM answer_captures
          WHERE project_id = $1 AND prompt_id = $2 AND engine_key = $3 AND sample_index = 0 AND brand_present IS NOT NULL
            AND ${measurementStatusSql("status")}
            AND ${observedAnswerSql("answer_captures")}
            AND (captured_at, id) < ($4::timestamptz, $5::uuid)
          ORDER BY captured_at DESC, id DESC LIMIT 1`,
        [projectId, after.prompt_id, after.engine_key, after.captured_at, after.id],
      )
    ).rows[0];

    const afterSnapshot = await loadSnapshot(tx, after, competitorDomains);
    await recoverOpenEvents(tx, workspaceId, projectId, after, afterSnapshot, competitorDomains);
    if (beforeRow === undefined) continue; // the first capture of a cell has nothing to be compared with

    const beforeSnapshot = await loadSnapshot(tx, beforeRow, competitorDomains);
    const detected = detectDisplacement(beforeSnapshot, afterSnapshot);
    if (detected.length === 0) continue;

    const context = await cellContext(tx, projectId, after, maxEngineWeight);
    const afterCitations = await loadCitationSlots(tx, after.id);
    const conceptNodes = await loadConceptNodes(tx, workspaceId, projectId, after.prompt_id);
    for (const event of detected) {
      const gap = await citationGap(tx, workspaceId, event, afterCitations);
      const conceptGap = conceptGapFor(conceptNodes, gap.map((g) => g.url));
      const impact = displacementImpactForEvent({
        kind: event.kind,
        beforePosition: event.beforePosition,
        afterPosition: event.afterPosition,
        beforeClass: event.beforePositionClass,
        afterClass: event.afterPositionClass,
        funnelStage: context.funnelStage,
        topicRankByIntent: context.topicRankByIntent,
        engineWeight: context.engineWeight,
        maxEngineWeight: context.maxEngineWeight,
        citationGap: gap.length,
      });
      const written = await tx.query<{ inserted: boolean; lag_seconds: number }>(
        `INSERT INTO displacement_events
           (workspace_id, project_id, prompt_id, engine_key, kind, before_result_id, after_result_id, before_position, after_position,
            before_position_class, after_position_class, displaced_by, citation_gap, concept_gap, impact_score, scoring_version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14::jsonb,$15,$16)
         ON CONFLICT (project_id, prompt_id, engine_key, kind, before_result_id, after_result_id) DO UPDATE
           SET displaced_by = EXCLUDED.displaced_by, citation_gap = EXCLUDED.citation_gap,
               concept_gap = CASE WHEN jsonb_array_length(displacement_events.concept_gap) = 0 THEN EXCLUDED.concept_gap ELSE displacement_events.concept_gap END,
               impact_score = EXCLUDED.impact_score, scoring_version = EXCLUDED.scoring_version
         RETURNING (xmax = 0) AS inserted, extract(epoch FROM (detected_at - $17::timestamptz))::float8 AS lag_seconds`,
        [
          workspaceId, projectId, after.prompt_id, after.engine_key, event.kind, event.beforeResultId, event.afterResultId,
          event.beforePosition, event.afterPosition, event.beforePositionClass, event.afterPositionClass,
          JSON.stringify(displacedBySchema.parse(event.displacedBy.map(toStoredEntity))),
          JSON.stringify(citationGapSchema.parse(gap)), JSON.stringify(conceptGapSchema.parse(conceptGap)), impact, SCORING_VERSION,
          after.captured_at,
        ],
      );
      const row = written.rows[0];
      if (observeLag && row?.inserted === true) lags.push(row.lag_seconds);
      persisted += 1;
    }
  }

  incrementCounter("nominara_rollup_displacements_persisted_total", { outcome: "ok" });
  logger.log({ event: "displacements_refreshed", workspaceId, projectId, date, events: persisted });
  return persisted;
}

/** A one-off pass over the captures that already exist, oldest day first (the order recovery needs). Idempotent. */
export async function backfillProjectDisplacements(
  tx: ClientBase,
  projectId: string,
  timezone: string,
  fromDate: string,
  toDate: string,
): Promise<number> {
  let total = 0;
  const workspaceId = (await tx.query<{ workspace_id: string }>(`SELECT workspace_id FROM projects WHERE id = $1`, [projectId])).rows[0]?.workspace_id;
  if (workspaceId === undefined) return 0; // not visible to this tenant context
  // Once per transaction, not once per date: the locks are held to commit anyway, and one up-front pass keeps the lock order fixed.
  await lockProjectNodeScopes(tx, workspaceId, projectId);
  for (const date of await datesWithFacts(tx, projectId, timezone, fromDate, toDate)) {
    // A backfill writes events long after their captures: its lag is not the live pipeline, so it is not observed.
    total += await refreshProjectDisplacements(tx, projectId, date, timezone, { observeLag: false, scopesLocked: true });
  }
  return total;
}

async function recoverOpenEvents(
  tx: ClientBase,
  workspaceId: string,
  projectId: string,
  later: CaptureRow,
  laterSnapshot: CaptureSnapshot,
  competitorDomains: ReadonlyMap<string, string | null>,
): Promise<void> {
  const open = (
    await tx.query<{ id: string; kind: DetectedDisplacement["kind"]; before_result_id: string }>(
      `SELECT e.id, e.kind, e.before_result_id
         FROM displacement_events e
         JOIN answer_captures a ON a.id = e.after_result_id
        WHERE e.project_id = $1 AND e.prompt_id = $2 AND e.engine_key = $3 AND e.recovered_at IS NULL
          AND (a.captured_at, a.id) < ($4::timestamptz, $5::uuid)`,
      [projectId, later.prompt_id, later.engine_key, later.captured_at, later.id],
    )
  ).rows;
  for (const event of open) {
    const beforeRow = (
      await tx.query<CaptureRow>(
        `SELECT id, prompt_id, engine_key, captured_at::text AS captured_at, brand_present, brand_rank_position FROM answer_captures WHERE id = $1`,
        [event.before_result_id],
      )
    ).rows[0];
    if (beforeRow === undefined) continue;
    const beforeSnapshot = await loadSnapshot(tx, beforeRow, competitorDomains);
    if (!restoresSlot(event.kind, beforeSnapshot, laterSnapshot)) continue;
    // The restoring capture's own time: deterministic, so a re-run writes the same value.
    const recovered = await tx.query(
      `UPDATE displacement_events SET recovered_at = $2::timestamptz WHERE id = $1 AND recovered_at IS NULL RETURNING id`,
      [event.id, later.captured_at],
    );
    if (recovered.rowCount === 1) await pinRecoveryMilestone(tx, workspaceId, event.id, event.kind);
  }
}

/**
 * STORY-056 AC9 — only when a task of the event (the linked first task or any task born of it) was completed BEFORE the
 * recovery. A task completed at or after the recovery instant, still open, dismissed or soft-deleted did not cause it, so
 * nothing is pinned. `visible_in_portal` is explicitly true: a recovery after the client's own completed work is a win the
 * portal shows (unlike the low-emphasis configuration pins). The pin names the event
 * (never the task or any answer text); `ON CONFLICT` on the (source_type, source_id) index makes it idempotent.
 */
async function pinRecoveryMilestone(tx: ClientBase, workspaceId: string, eventId: string, kind: DetectedDisplacement["kind"]): Promise<void> {
  const pinned = await tx.query<{ id: string }>(
    `INSERT INTO milestones (workspace_id, project_id, occurred_at, kind, title, severity, source_type, source_id, affected_engines, visible_in_portal)
     SELECT e.workspace_id, e.project_id, e.recovered_at, 'displacement_recovered', $2, 'positive', 'system', e.id, ARRAY[e.engine_key], true
       FROM displacement_events e
      WHERE e.id = $1 AND e.recovered_at IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM tasks t
           WHERE (t.id = e.task_id OR t.source_displacement_id = e.id)
             AND t.status = 'done' AND t.deleted_at IS NULL AND t.completed_at < e.recovered_at)
     ON CONFLICT (source_type, source_id) WHERE source_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [eventId, RECOVERY_TITLE[kind]],
  );
  if (pinned.rowCount === 1) {
    incrementCounter("nominara_rollup_displacement_recovery_milestones_total", { outcome: "pinned" });
    logger.log({ event: "displacement_recovery_milestone_pinned", workspaceId, displacementEventId: eventId, milestoneId: pinned.rows[0]!.id });
  }
}

interface MentionRow {
  entity_type: string;
  entity_id: string | null;
  entity_label: string;
  prominence: number;
  list_position: number | null;
  position_class: string;
  render_form: string;
}

async function loadSnapshot(
  tx: ClientBase,
  capture: CaptureRow,
  competitorDomains: ReadonlyMap<string, string | null>,
): Promise<CaptureSnapshot> {
  const mentions = (
    await tx.query<MentionRow>(
      `SELECT entity_type, entity_id, entity_label, prominence::float8 AS prominence, list_position, position_class, render_form
         FROM mention_facts WHERE result_id = $1 ORDER BY prominence DESC, char_start`,
      [capture.id],
    )
  ).rows;
  const brand = mentions.find((m) => m.entity_type === "brand");

  const grouped = new Map<string, MentionRow[]>();
  for (const m of mentions.filter((x) => x.entity_type !== "brand")) {
    const key = m.entity_id ?? `label:${m.entity_label}`;
    grouped.set(key, [...(grouped.get(key) ?? []), m]);
  }
  const slots = await loadCitationSlots(tx, capture.id);
  const entities: SnapshotEntity[] = [...grouped.values()].map((rows) => {
    const lead = rows[0]!; // highest prominence
    const positions = rows.map((r) => r.list_position).filter((p): p is number => p !== null);
    const rootDomain = lead.entity_id === null ? null : (competitorDomains.get(lead.entity_id) ?? null);
    return {
      entityLabel: lead.entity_label,
      entityId: lead.entity_id,
      isTracked: lead.entity_type === "competitor",
      position: positions.length === 0 ? null : Math.min(...positions),
      prominence: Math.max(...rows.map((r) => r.prominence)),
      positionClass: lead.position_class,
      citations: rootDomain === null ? [] : slots.filter((s) => domainMatches(s.domain, rootDomain)).map(toSnapshotCitation),
    };
  });

  return {
    resultId: capture.id,
    brandPresent: capture.brand_present,
    brandPosition: capture.brand_present ? capture.brand_rank_position : null,
    brandPositionClass: brand === undefined ? null : [...mentions.filter((m) => m.entity_type === "brand")].sort(byClass)[0]!.position_class,
    brandRenderForm: brand?.render_form ?? null,
    entities,
  };
}

function byClass(a: MentionRow, b: MentionRow): number {
  return CLASS_ORDER.indexOf(a.position_class) - CLASS_ORDER.indexOf(b.position_class);
}

interface CitationSlot {
  url: string;
  domain: string;
  sourceClass: string;
  isOwned: boolean;
}

/** The after-capture's resolved, deduplicated slots (best slot per URL). Unresolved URLs are not sources — the index excludes them too. */
async function loadCitationSlots(tx: ClientBase, resultId: string): Promise<CitationSlot[]> {
  const rows = (
    await tx.query<{ normalized_url: string; domain: string; source_class: string | null; is_owned: boolean }>(
      `SELECT DISTINCT ON (normalized_url) normalized_url, domain, source_class, is_owned
         FROM citation_facts WHERE result_id = $1 AND http_status IS NOT NULL
        ORDER BY normalized_url, slot_index`,
      [resultId],
    )
  ).rows;
  return rows.map((r) => ({ url: r.normalized_url, domain: r.domain, sourceClass: r.source_class ?? classifyDomain(r.domain), isOwned: r.is_owned }));
}

function domainMatches(domain: string, rootDomain: string): boolean {
  const d = domain.toLowerCase();
  const root = rootDomain.toLowerCase();
  return d === root || d.endsWith(`.${root}`);
}

function toSnapshotCitation(slot: CitationSlot): SnapshotCitation {
  return { url: slot.url, domain: slot.domain, sourceClass: slot.sourceClass };
}

function toStoredEntity(e: SnapshotEntity): Record<string, unknown> {
  return {
    entity_label: e.entityLabel,
    entity_id: e.entityId,
    is_tracked: e.isTracked,
    position: e.position,
    prominence: e.prominence,
    position_class: e.positionClass,
    citations: e.citations.map((c) => ({ url: c.url, domain: c.domain, source_class: c.sourceClass })),
  };
}

/** STORY-057 AC1/AC2 — what the displacers hold on the after-capture that the brand does not. */
async function citationGap(
  tx: ClientBase,
  workspaceId: string,
  event: DetectedDisplacement,
  afterSlots: readonly CitationSlot[],
): Promise<CitationGapEntry[]> {
  const brandUrls = new Set(afterSlots.filter((s) => s.isOwned).map((s) => s.url));
  const byUrl = new Map<string, { slot: SnapshotCitation; heldBy: string[] }>();
  for (const entity of event.displacedBy) {
    for (const citation of entity.citations) {
      if (brandUrls.has(citation.url)) continue;
      const entry = byUrl.get(citation.url) ?? { slot: citation, heldBy: [] };
      if (!entry.heldBy.includes(entity.entityLabel)) entry.heldBy.push(entity.entityLabel);
      byUrl.set(citation.url, entry);
    }
  }
  const gap: CitationGapEntry[] = [];
  for (const { slot, heldBy } of byUrl.values()) {
    gap.push({
      url: slot.url,
      domain: slot.domain,
      source_class: slot.sourceClass as CitationGapEntry["source_class"],
      held_by: heldBy,
      brand_present: await verifiedBrandPresence(tx, workspaceId, slot.domain),
    });
  }
  return gap.sort((a, b) => a.url.localeCompare(b.url));
}

/**
 * STORY-057 AC4/AC5 - the concepts the displacing entities' cited sources cover (FR-CO-03(d)) that the page lacks.
 *
 * Candidates: `semantic_nodes` of the prompt's cluster (STORY-059), live (not collapsed into a near-duplicate), absent from the
 * content, and JUDGED. `present_in_content` defaults to false, so an unjudged node would read as "absent". A node is judged iff an
 * alignment of its scope has `coverage_ratio IS NOT NULL`: `analyseNodes` sets it, and `extractSemanticNodes` clears it on every
 * alignment of the scope in the transaction that resets the nodes (so a recompute of a centroid or an alignment, which touch
 * `updated_at` but not this column, cannot make a freshly extracted node look judged). A READY alignment keeps its coverage_ratio through a
 * later extraction (it is that session's own finished result), so the nodes are also un-judged while any alignment of the scope is still
 * `pending`: that is the window in which the extraction has reset the nodes and the new session has not analysed them. Fail closed.
 *
 * Then three filters, in this order, none of which invents a concept:
 *   1. low confidence: a centroid built from fewer than the minimum passages keeps only priority_rank <= 3, a null rank dropped
 *      (the GEO panel's own rule, `suppressRecommendations`). The thinnest judging alignment decides.
 *   2. cited: the evidence URL must be one of the stored `citation_gap` URLs of this event (`deriveConceptGap`).
 *   3. threshold and evidence (`deriveConceptGap`).
 *
 * BUILDER READING (open with the owner): "the brand's page" is whatever page the latest analysis of the cluster read; the reference
 * names none for a displacement. OPEN: `analyseNodes(draft: true)` also sets `present_in_content` and `coverage_ratio` from an UNSAVED
 * draft, which would count as "judged" here; no caller passes draft today. Before draft analysis ships, exclude draft-judged
 * alignments (needs a marker of the analysis source) or keep draft presence off the shared nodes.
 * WIRING: nothing in src calls `openAlignmentSession` / `extractSemanticNodes` / `analyseNodes` yet (no `geo.analyze` handler, no
 * session route), so in production no scope is ever judged and the gap is always [] until STORY-059's pipeline is wired. ACCEPTED LIMITATION: the gap is written when the event is first stored (or filled while empty), so a
 * backfill over an old date describes today's corpus; the cited-source filter bounds that to sources that capture actually cited.
 */
interface ConceptNode extends ConceptCandidate {
  readonly priorityRank: number | null;
}
interface ConceptNodes {
  readonly nodes: readonly ConceptNode[];
  readonly lowConfidence: boolean;
}

/** Every cluster scope of the project's prompts (and the unclustered scope), shared-locked in the one order embed-batch uses. */
async function lockProjectNodeScopes(tx: ClientBase, workspaceId: string, projectId: string): Promise<void> {
  const scopes = await tx.query<{ cluster_id: string | null }>(
    `SELECT DISTINCT cluster_id FROM tracked_prompts WHERE workspace_id = $1 AND project_id = $2`,
    [workspaceId, projectId],
  );
  await lockNodeScopesShared(tx, projectId, scopes.rows.map((r) => r.cluster_id));
}

async function loadConceptNodes(tx: ClientBase, workspaceId: string, projectId: string, promptId: string): Promise<ConceptNodes> {
  const clusterId =
    (await tx.query<{ cluster_id: string | null }>(`SELECT cluster_id FROM tracked_prompts WHERE id = $1 AND workspace_id = $2 AND project_id = $3`, [promptId, workspaceId, projectId]))
      .rows[0]?.cluster_id ?? null;
  // The judged check and the node read are two statements with two snapshots (READ COMMITTED); the scope's shared lock, taken up front
  // by `lockProjectNodeScopes`, stops a commit between them pairing "judged" with freshly reset (all-absent) nodes.
  const judging = (
    await tx.query<{ min_sources: number | null }>(
      `SELECT min(centroid_source_count)::int AS min_sources
         FROM geo_alignments
        WHERE workspace_id = $1 AND project_id = $2 AND prompt_cluster_id IS NOT DISTINCT FROM $3 AND coverage_ratio IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM geo_alignments p
                           WHERE p.workspace_id = $1 AND p.project_id = $2 AND p.prompt_cluster_id IS NOT DISTINCT FROM $3 AND p.analysis_state = 'pending')`,
      [workspaceId, projectId, clusterId],
    )
  ).rows[0];
  // No judging alignment: nothing has been judged, so there is no claim to make.
  if (judging?.min_sources === null || judging === undefined) return { nodes: [], lowConfidence: true };
  const rows = (
    await tx.query<{ phrase: string; prevalence: number; evidence_url: string | null; priority_rank: number | null }>(
      `SELECT n.phrase, n.corpus_doc_ratio::float8 AS prevalence, n.evidence_url, n.priority_rank::int AS priority_rank
         FROM semantic_nodes n
        WHERE n.workspace_id = $1 AND n.project_id = $2 AND n.prompt_cluster_id IS NOT DISTINCT FROM $3
          AND n.collapsed_into_id IS NULL AND NOT n.present_in_content
        ORDER BY n.priority_rank NULLS LAST, n.corpus_doc_ratio DESC, n.phrase_normalized, n.id`,
      [workspaceId, projectId, clusterId],
    )
  ).rows;
  return {
    nodes: rows.map((r) => ({ phrase: r.phrase, prevalence: r.prevalence, evidenceUrl: r.evidence_url, priorityRank: r.priority_rank })),
    lowConfidence: isLowConfidence(judging.min_sources),
  };
}

function conceptGapFor(loaded: ConceptNodes, citedUrls: readonly string[]): ConceptGapEntry[] {
  const kept = suppressRecommendations(
    loaded.nodes.map((n) => ({ ...n, priority_rank: n.priorityRank })),
    loaded.lowConfidence,
  );
  const suppressed = loaded.nodes.length - kept.length;
  const result = deriveConceptGap(kept, citedUrls);
  // Counts only: never a phrase or a URL (log hygiene). Zero is a measurement and is emitted.
  observeValue("nominara_displacement_concept_gap_entries", result.entries.length, { outcome: "kept" });
  observeValue("nominara_displacement_concept_gap_entries", result.droppedBelowThreshold, { outcome: "dropped_below_threshold" });
  observeValue("nominara_displacement_concept_gap_entries", result.droppedNoEvidence, { outcome: "dropped_no_evidence" });
  observeValue("nominara_displacement_concept_gap_entries", result.droppedNotCited, { outcome: "dropped_not_cited" });
  observeValue("nominara_displacement_concept_gap_entries", suppressed, { outcome: "suppressed_low_confidence" });
  return result.entries;
}

/** From the verified index only; `null` when never verified — absence is not assumed. */
async function verifiedBrandPresence(tx: ClientBase, workspaceId: string, domain: string): Promise<boolean | null> {
  const row = (
    await tx.query<{ present: boolean }>(
      `SELECT psi.brand_present_on_domain AS present
         FROM project_source_index psi JOIN source_domains sd ON sd.id = psi.source_domain_id
        WHERE sd.workspace_id = $1 AND sd.domain = $2 AND psi.verified_at IS NOT NULL AND psi.brand_present_on_domain IS NOT NULL
        ORDER BY psi.verified_at DESC LIMIT 1`,
      [workspaceId, domain],
    )
  ).rows[0];
  return row?.present ?? null;
}

/**
 * CONFIRMED v1 READING (owner decision 2026-10-27, item 3; was flagged at CP2 QA, STORY-056 criterion 4).
 * scoring-models.md section 9 uses `rank_of_topic_by_intent` and defines no
 * ordering rule for it. This takes the plan's reading: rank 1 for EVERY prompt,
 * so `1 / rank` is 1 and prompt_weight is `0.5 * commercial_intent + 0.5`.
 * Ranking `topic_clusters` by their commercial_intent is the alternative; it is
 * not taken because the spec does not say to, and a silent invention would move
 * every stored impact score. Pinned by the CP2 STORY-056 rank test; scoring-models.md section 9 is to state it (docs batch, STORY-056 patch).
 *
 * GOLDEN-SET GATE: there is no golden-set runner for the D1 scoring change, so
 * that gate is UNAVAILABLE for STORY-056 and was not run. `scoring_version` is
 * stamped on each row but was not bumped and there is no dual-compute.
 */
const TOPIC_RANK_BY_INTENT = 1;

async function cellContext(tx: ClientBase, projectId: string, cell: CaptureRow, maxEngineWeight: number): Promise<CellContext> {
  const prompt = (
    await tx.query<{ funnel_stage: FunnelStage }>(`SELECT funnel_stage FROM tracked_prompts WHERE id = $1`, [cell.prompt_id])
  ).rows[0];
  const weight = (
    await tx.query<{ weight: number }>(`SELECT weight::float8 AS weight FROM project_engines WHERE project_id = $1 AND engine_key = $2`, [
      projectId,
      cell.engine_key,
    ])
  ).rows[0]?.weight;
  const engineWeight = weight ?? 1;
  return {
    funnelStage: prompt?.funnel_stage ?? "consideration",
    topicRankByIntent: TOPIC_RANK_BY_INTENT,
    engineWeight,
    maxEngineWeight: Math.max(maxEngineWeight, engineWeight),
  };
}
