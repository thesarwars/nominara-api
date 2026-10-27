import { Logger } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { ClientBase } from "pg";
import {
  citationGapSchema,
  conceptGapSchema,
  displacedBySchema,
  type CitationGapEntry,
} from "../../../contracts/analytics/displacement-event.schema.js";
import {
  detectDisplacement,
  restoresSlot,
  type CaptureSnapshot,
  type DetectedDisplacement,
  type SnapshotCitation,
  type SnapshotEntity,
} from "../analytics/displacement.js";
import { classifyDomain } from "../parser/citation-url.js";
import { displacementImpactForEvent, type FunnelStage } from "../scoring/displacement-impact.js";
import { SCORING_VERSION } from "../scoring/index.js";
import { incrementCounter, observeValue } from "../telemetry/metrics.js";
import { datesWithFacts, measurementStatusSql } from "./aggregate-day.js";

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
// `concept_gap` is `[]` — no corpus exists (STORY-058).
//
// A recovery that follows a COMPLETED task (the event's linked `task_id` is `done`,
// not deleted, with `completed_at` strictly before `recovered_at`) pins a
// `displacement_recovered` milestone at the recovery instant (STORY-056 AC9).
// It is keyed `(system, event id)`, so a re-run can never pin it twice.
//
// Detection lag (AC11): the first insert of an event observes
// `detected_at - after.captured_at` in seconds; a re-run only updates, so it does
// not observe again.
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

export async function refreshProjectDisplacements(tx: ClientBase, projectId: string, date: string, timezone: string): Promise<number> {
  return tracer.startActiveSpan("displacement.refresh", async (span) => {
    try {
      const persisted = await refreshProjectDisplacementsInner(tx, projectId, date, timezone);
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

async function refreshProjectDisplacementsInner(tx: ClientBase, projectId: string, date: string, timezone: string): Promise<number> {
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
        ORDER BY captured_at, id`,
      [projectId, timezone, date],
    )
  ).rows;
  if (captures.length === 0) return 0;

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
            AND (captured_at, id) < ($4::timestamptz, $5::uuid)
          ORDER BY captured_at DESC, id DESC LIMIT 1`,
        [projectId, after.prompt_id, after.engine_key, after.captured_at, after.id],
      )
    ).rows[0];

    const afterSnapshot = await loadSnapshot(tx, after, competitorDomains);
    await recoverOpenEvents(tx, projectId, after, afterSnapshot, competitorDomains);
    if (beforeRow === undefined) continue; // the first capture of a cell has nothing to be compared with

    const beforeSnapshot = await loadSnapshot(tx, beforeRow, competitorDomains);
    const detected = detectDisplacement(beforeSnapshot, afterSnapshot);
    if (detected.length === 0) continue;

    const context = await cellContext(tx, projectId, after, maxEngineWeight);
    const afterCitations = await loadCitationSlots(tx, after.id);
    for (const event of detected) {
      const gap = await citationGap(tx, workspaceId, event, afterCitations);
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
               impact_score = EXCLUDED.impact_score, scoring_version = EXCLUDED.scoring_version
         RETURNING (xmax = 0) AS inserted, extract(epoch FROM (detected_at - $17::timestamptz))::float8 AS lag_seconds`,
        [
          workspaceId, projectId, after.prompt_id, after.engine_key, event.kind, event.beforeResultId, event.afterResultId,
          event.beforePosition, event.afterPosition, event.beforePositionClass, event.afterPositionClass,
          JSON.stringify(displacedBySchema.parse(event.displacedBy.map(toStoredEntity))),
          JSON.stringify(citationGapSchema.parse(gap)), JSON.stringify(conceptGapSchema.parse([])), impact, SCORING_VERSION,
          after.captured_at,
        ],
      );
      const row = written.rows[0];
      if (row?.inserted === true) observeValue(LAG_METRIC, row.lag_seconds, { outcome: "ok" });
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
  for (const date of await datesWithFacts(tx, projectId, timezone, fromDate, toDate)) {
    total += await refreshProjectDisplacements(tx, projectId, date, timezone);
  }
  return total;
}

async function recoverOpenEvents(
  tx: ClientBase,
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
    if (recovered.rowCount === 1) await pinRecoveryMilestone(tx, event.id, event.kind);
  }
}

/**
 * STORY-056 AC9 — only when the event's linked task was completed BEFORE the recovery. A task completed at or after the
 * recovery instant, still open, dismissed or soft-deleted did not cause it, so nothing is pinned. The pin names the event
 * (never the task or any answer text); `ON CONFLICT` on the (source_type, source_id) index makes it idempotent.
 */
async function pinRecoveryMilestone(tx: ClientBase, eventId: string, kind: DetectedDisplacement["kind"]): Promise<void> {
  const pinned = await tx.query<{ id: string }>(
    `INSERT INTO milestones (workspace_id, project_id, occurred_at, kind, title, severity, source_type, source_id, affected_engines)
     SELECT e.workspace_id, e.project_id, e.recovered_at, 'displacement_recovered', $2, 'positive', 'system', e.id, ARRAY[e.engine_key]
       FROM displacement_events e
       JOIN tasks t ON t.id = e.task_id
      WHERE e.id = $1 AND e.recovered_at IS NOT NULL
        AND t.status = 'done' AND t.deleted_at IS NULL AND t.completed_at < e.recovered_at
     ON CONFLICT (source_type, source_id) WHERE source_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [eventId, RECOVERY_TITLE[kind]],
  );
  if (pinned.rowCount === 1) {
    incrementCounter("nominara_rollup_displacement_recovery_milestones_total", { outcome: "pinned" });
    logger.log({ event: "displacement_recovery_milestone_pinned", displacementEventId: eventId, milestoneId: pinned.rows[0]!.id });
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
 * every stored impact score. Pinned by the CP2 STORY-056 rank test; scoring-models.md section 9 states it.
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
