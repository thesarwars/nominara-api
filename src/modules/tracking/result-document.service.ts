import { Injectable } from "@nestjs/common";
import type {
  Highlight,
  ResultCitation,
  ResultDocument,
  ResultEntity,
} from "../../../contracts/tracking/index.js";
import { RESULT_DOCUMENT_SCHEMA } from "../../../contracts/tracking/index.js";
import { NotFoundError, PreconditionUnmetError } from "../../api/errors/domain-errors.js";
import { assertProjectInScope } from "../../tenancy/project-scope.js";
import { currentTenantStore } from "../../tenancy/tenant-context.js";
import { normalize, requiresReparse } from "../../lib/parser/normalize.js";
import { isRawExpired } from "./raw-retention.js";

/**
 * Appended to `flags` when the highlight map is WITHHELD because the stored offsets were computed under another normaliser version
 * (STORY-091 audit). `flags` is an open string list in the contract, so this is a value, not a field: the client reads it to say
 * "highlights unavailable until re-parse" rather than showing an unannotated answer as if nothing had been mentioned.
 */
export const HIGHLIGHTS_WITHHELD_FLAG = "highlights_withheld_normalizer_stale";

// STORY-034 AC7 — `GET /v1/results/{id}`, §6's parser document.
//
// Unblocked by STORY-135: this reads `mention_facts` and `citation_facts`,
// and until the parse stage existed nothing wrote them.
//
// THE HIGHLIGHT MAP IS BUILT HERE, and it is the reason the drawer can
// promise never to render engine markup. The client receives the verbatim
// text and a list of offsets; it has no markup to render because none is
// sent. STORY-091's note: "Converting offsets into one element type means the
// renderer has no code path that can emit anything else, which is why the
// guarantee is structural rather than a sanitiser call that someone may
// forget." That structure starts on this side of the wire.

interface CaptureRow {
  id: string;
  project_id: string;
  run_id: string;
  prompt_id: string;
  engine_key: string;
  sample_index: number;
  captured_at: Date;
  capture_mode: "api" | "licensed_serp" | "headless";
  adapter_version: string;
  model_fingerprint: string | null;
  normalizer_version: string;
  scoring_version: string;
  latency_ms: number | null;
  response_tokens_est: number | null;
  truncated: boolean;
  content_hash: Buffer;
  raw_object_key: string | null;
  response_excerpt: string | null;
  payload: { text?: unknown; format?: unknown; raw_expired?: unknown } | null;
  status: "captured" | "parsed" | "failed" | "blocked" | "skipped";
  error_code: string | null;
  cache_layer: "live" | "l1" | "l2";
  source_result_id: string | null;
  brand_present: boolean | null;
  brand_rank_position: number | null;
  sov: number | null;
  sentiment_label: "positive" | "neutral" | "negative" | "absent" | null;
  sentiment_score: number | null;
  citation_count: number;
  owned_citation_count: number;
  flags: string[];
  prompt_text: string;
  intent_archetype: string;
  funnel_stage: string;
  cluster_id: string | null;
  engine_display_name: string | null;
}

interface MentionRow {
  entity_type: "brand" | "competitor" | "other";
  entity_id: string | null;
  entity_label: string;
  matched_alias: string;
  occurrence_index: number;
  char_start: number;
  char_end: number;
  first_token_index: number;
  list_position: number | null;
  prominence: number;
  sentiment_label: "positive" | "neutral" | "negative";
  sentiment_score: number;
  sentiment_confidence: number;
  sentiment_method: "lexicon" | "heuristic" | "llm_arbiter" | "arbiter_rejected";
  evidence_start: number | null;
  evidence_end: number | null;
  negative_reasons: string[];
  render_form: ResultEntity["render"]["form"];
  render_attrs: string[];
  render_score: number;
  position_class: ResultEntity["position_class"];
  answer_form: string | null;
}

@Injectable()
export class ResultDocumentService {
  async get(resultId: string): Promise<ResultDocument> {
    const store = currentTenantStore();
    if (store === undefined) throw new Error("ResultDocumentService requires an active tenant context");

    const found = await store.client.query<CaptureRow>(
      `SELECT c.id, c.project_id, c.run_id, c.prompt_id, c.engine_key, c.sample_index, c.captured_at,
              c.capture_mode, c.adapter_version, c.model_fingerprint, c.normalizer_version, c.scoring_version,
              c.latency_ms, c.response_tokens_est, c.truncated, c.content_hash, c.raw_object_key,
              c.payload, c.response_excerpt, c.status, c.error_code, c.cache_layer, c.source_result_id,
              c.brand_present, c.brand_rank_position, c.sov, c.sentiment_label, c.sentiment_score,
              c.citation_count, c.owned_citation_count, c.flags,
              p.text AS prompt_text, p.intent_archetype, p.funnel_stage, p.cluster_id,
              e.display_name AS engine_display_name
         FROM answer_captures c
         JOIN tracked_prompts p ON p.id = c.prompt_id
         LEFT JOIN engines e ON e.key = c.engine_key
        WHERE c.id = $1 AND c.workspace_id = app.current_workspace()`,
      [resultId],
    );

    const capture = found.rows[0];
    if (capture === undefined) throw new NotFoundError({ message: "no such result" });
    // The id names a result, not a project: a scoped member is checked against the row's own project.
    await assertProjectInScope(store.client, capture.project_id);
    // Owner decision 100(f) (STORY-077 R2; replaces the 507 THIS route gave under STORY-034 AC10): past the plan's raw-capture retention the document is
    // served with its facts and excerpt, no raw text, and `raw_expired: true`. The text is not read at all (an L2 row's source is not touched), and the
    // answer is never quietly empty: the flag says why. /raw, /reparse and the list stay 507.
    const rawExpired = await isRawExpired(store.client, store.context.workspaceId, { capturedAt: capture.captured_at, rawExpired: capture.payload?.raw_expired });

    // THE TEXT EVERY OFFSET INDEXES. `mention_facts.char_*` and `evidence_*` are computed against normalize(raw) by the parse stage, and
    // the document asserts `normalized_text_offsets: true`; serving the raw text shifted every highlight after the first CRLF, zero-width
    // space, NFD sequence or 3+ newline run. An L2 row has no text of its own and reads its source's, scoped to this workspace and project.
    const resolved = rawExpired ? { text: "", format: typeof capture.payload?.format === "string" ? capture.payload.format : "markdown" } : await resolveRawText(store.client, capture);
    const text = normalize(resolved.text);
    // Offsets written under another normaliser version index a string this normaliser no longer produces: serve the text, withhold the
    // highlights, and say so. A wrong highlight is worse than none.
    const withheld = requiresReparse(capture.normalizer_version);

    // A CELL THAT COULD NOT BE CAPTURED HAS NO DOCUMENT, and saying so beats
    // returning an empty one. An empty `raw_response.text` with no entities
    // renders in the drawer as an answer that mentioned nobody — which is a
    // measurement, and the opposite of what a failed cell means.
    if (capture.status === "failed" || capture.status === "blocked") {
      throw new PreconditionUnmetError({
        message: `this cell was not captured (${capture.status}${capture.error_code === null ? "" : `: ${capture.error_code}`})`,
      });
    }

    const mentions = await store.client.query<MentionRow>(
      `SELECT entity_type, entity_id, entity_label, matched_alias, occurrence_index,
              char_start, char_end, first_token_index, list_position, prominence,
              sentiment_label, sentiment_score, sentiment_confidence, sentiment_method,
              evidence_start, evidence_end, negative_reasons,
              render_form, render_attrs, render_score, position_class, answer_form
         FROM mention_facts
        WHERE result_id = $1 AND workspace_id = app.current_workspace()
        ORDER BY char_start`,
      [resultId],
    );

    const citations = await store.client.query<Record<string, unknown>>(
      `SELECT slot_index, raw_url, normalized_url, domain, path, anchor_text, title,
              is_owned, is_competitor, source_class, http_status, resolved_at,
              position_weight, text_fragment
         FROM citation_facts
        WHERE result_id = $1 AND workspace_id = app.current_workspace()
        ORDER BY slot_index`,
      [resultId],
    );

    return {
      schema: RESULT_DOCUMENT_SCHEMA,
      result_id: capture.id,
      project_id: capture.project_id,
      run_id: capture.run_id,
      prompt: {
        prompt_id: capture.prompt_id,
        text: capture.prompt_text,
        intent_archetype: capture.intent_archetype,
        funnel_stage: capture.funnel_stage,
        cluster_id: capture.cluster_id,
      },
      engine: {
        key: capture.engine_key,
        // The catalog is unseeded (STORY-130), so the key stands in for the
        // display name rather than the field going blank. A drawer header
        // reading nothing is worse than one reading `chatgpt`.
        display_name: capture.engine_display_name ?? capture.engine_key,
        capture_mode: capture.capture_mode,
        adapter_version: capture.adapter_version,
        model_fingerprint: capture.model_fingerprint,
      },
      capture: {
        captured_at: capture.captured_at.toISOString(),
        sample_index: capture.sample_index,
        latency_ms: capture.latency_ms,
        response_tokens_est: capture.response_tokens_est,
        response_chars: text.length,
        truncated: capture.truncated,
        content_hash: `sha256:${capture.content_hash.toString("hex")}`,
        normalizer_version: capture.normalizer_version,
        raw_object_key: capture.raw_object_key,
        status: capture.status,
        error_code: capture.error_code,
      },
      cache: {
        layer: capture.cache_layer,
        hit: capture.cache_layer !== "live",
        source_result_id: capture.source_result_id,
      },
      raw_response: {
        format: resolved.format,
        char_count: text.length,
        text,
        normalized_text_offsets: true,
        // The excerpt outlives the raw text (data-model.md retention); served only when the text is gone.
        ...(rawExpired ? { excerpt: capture.response_excerpt } : {}),
      },
      raw_expired: rawExpired,
      entities: groupEntities(mentions.rows, withheld),
      citations: citations.rows.map(toCitation),
      metrics: {
        scoring_version: capture.scoring_version,
        brand_present: capture.brand_present,
        brand_rank_position: capture.brand_rank_position,
        share_of_voice: capture.sov,
        citation_count: capture.citation_count,
        owned_citation_count: capture.owned_citation_count,
        // Computed from the citations rather than stored: `citation_share` is
        // a window metric on `metric_daily`, and the per-response figure the
        // drawer shows is this one.
        citation_share: citationShareOf(citations.rows),
        sentiment_label: capture.sentiment_label,
        sentiment_score: capture.sentiment_score,
      },
      highlight_map: withheld || rawExpired ? [] : buildHighlightMap(mentions.rows, text.length),
      flags: withheld && !capture.flags.includes(HIGHLIGHTS_WITHHELD_FLAG) ? [...capture.flags, HIGHLIGHTS_WITHHELD_FLAG] : capture.flags,
    };
  }
}

/**
 * The row's own answer, or - for a reused (L2) row, which stores none - its source's. The same resolution as the parse handler's
 * `reusedTextOf`: the predicate carries the workspace AND the project because `source_result_id` has no foreign key, so a stale or
 * poisoned pointer must resolve to nothing rather than to another tenant's or project's answer.
 */
async function resolveRawText(
  client: { query: <R>(text: string, values: unknown[]) => Promise<{ rows: R[] }> },
  capture: CaptureRow,
): Promise<{ text: string; format: string }> {
  const own = capture.payload?.text;
  const formatOf = (payload: CaptureRow["payload"]): string => (typeof payload?.format === "string" ? payload.format : "markdown");
  if (typeof own === "string" && own.length > 0) return { text: own, format: formatOf(capture.payload) };
  if (capture.source_result_id === null) return { text: typeof own === "string" ? own : "", format: formatOf(capture.payload) };
  const source = await client.query<{ payload: CaptureRow["payload"] }>(
    "SELECT payload FROM answer_captures WHERE id = $1 AND workspace_id = app.current_workspace() AND project_id = $2",
    [capture.source_result_id, capture.project_id],
  );
  const sourcePayload = source.rows[0]?.payload ?? null;
  const text = sourcePayload?.text;
  // An L2 row stores no payload of its own, so the format is the SOURCE's.
  return { text: typeof text === "string" ? text : "", format: formatOf(sourcePayload) };
}

/**
 * One entry per entity, with its occurrences nested.
 *
 * `mention_facts` is one row per OCCURRENCE; §6's document is one entry per
 * ENTITY carrying its occurrences. The entity-level fields — prominence, rank,
 * render, sentiment — are taken from the entity's FIRST occurrence in document
 * order, which is the one prominence is computed against (§2.1's maximum lands
 * on the best-placed mention, and the parse stage writes the same entity-level
 * prominence onto every row of that entity).
 */
function groupEntities(rows: readonly MentionRow[], withheld: boolean): ResultEntity[] {
  const byEntity = new Map<string, MentionRow[]>();
  for (const row of rows) {
    const key = `${row.entity_type}:${row.entity_id ?? row.entity_label}`;
    byEntity.set(key, [...(byEntity.get(key) ?? []), row]);
  }

  return [...byEntity.values()].map((occurrences) => {
    const first = occurrences[0]!;
    return {
      entity_type: first.entity_type,
      entity_id: first.entity_id,
      label: first.entity_label,
      matched_alias: first.matched_alias,
      // WITHHELD: every offset indexes a string this normaliser no longer produces, so none leaves the server. `char_start`/`char_end` are
      // non-nullable in the contract, so the occurrences are omitted (the entity, its sentiment and its prominence stay); the evidence
      // span is nullable and is nulled.
      occurrences: (withheld ? [] : occurrences).map((row) => ({
        occurrence_index: row.occurrence_index,
        char_start: row.char_start,
        char_end: row.char_end,
        first_token_index: row.first_token_index,
        list_position: row.list_position,
        // `mention_facts` has no `in_link` column — recorded as a schema gap
        // in STORY-036. Reported as false rather than omitted, because the
        // field is part of §6's shape and a missing key would read as
        // "unknown" where the honest answer is "we cannot say".
        in_link: false,
      })),
      rank_position: first.list_position,
      prominence: first.prominence,
      render: { form: first.render_form, attrs: first.render_attrs, score: first.render_score },
      position_class: first.position_class,
      answer_form: first.answer_form,
      sentiment: {
        label: first.sentiment_label,
        score: first.sentiment_score,
        confidence: first.sentiment_confidence,
        method: first.sentiment_method,
        evidence_char_start: withheld ? null : first.evidence_start,
        evidence_char_end: withheld ? null : first.evidence_end,
        negative_reasons: first.negative_reasons,
      },
    };
  });
}

/**
 * The highlight map — offsets and a class, and nothing else.
 *
 * SPANS OUTSIDE THE TEXT ARE DROPPED, NOT CLAMPED. STORY-091's scenario 15
 * asks for "rejected safely; no partial render, no exception surfaced to the
 * user", and dropping is what delivers all three: a clamped span highlights
 * the wrong characters, and throwing takes the whole drawer down over one bad
 * row. A stored offset past the end means the text and the facts disagree
 * about which string they describe — a re-parse fixes it, and until then the
 * answer renders correctly with one highlight missing.
 *
 * OVERLAPS ARE DROPPED TOO. A renderer walking a sorted, non-overlapping list
 * can emit markers with a single pass and no nesting logic; overlapping spans
 * would need it to decide which wins, and a renderer making decisions about
 * untrusted offsets is the thing this design exists to avoid.
 */
function buildHighlightMap(rows: readonly MentionRow[], textLength: number): Highlight[] {
  const sorted = [...rows]
    .filter((row) => row.char_start >= 0 && row.char_end <= textLength && row.char_end > row.char_start)
    .sort((a, b) => a.char_start - b.char_start || b.char_end - a.char_end);

  const map: Highlight[] = [];
  let lastEnd = 0;
  for (const row of sorted) {
    if (row.char_start < lastEnd) continue;
    map.push({
      char_start: row.char_start,
      char_end: row.char_end,
      class: `${row.entity_type}-${row.sentiment_label}` as Highlight["class"],
      entity_id: row.entity_id,
    });
    lastEnd = row.char_end;
  }
  return map;
}

function toCitation(row: Record<string, unknown>): ResultCitation {
  return {
    slot_index: Number(row.slot_index),
    raw_url: String(row.raw_url),
    normalized_url: String(row.normalized_url),
    domain: String(row.domain),
    path: row.path === null ? null : String(row.path),
    anchor_text: row.anchor_text === null ? null : String(row.anchor_text),
    title: row.title === null ? null : String(row.title),
    is_owned: Boolean(row.is_owned),
    is_competitor: Boolean(row.is_competitor),
    source_class: row.source_class === null ? null : String(row.source_class),
    http_status: row.http_status === null ? null : Number(row.http_status),
    resolved_at: row.resolved_at instanceof Date ? row.resolved_at.toISOString() : null,
    position_weight: Number(row.position_weight),
    text_fragment: row.text_fragment === null ? null : String(row.text_fragment),
  };
}

/** §4 — owned position weight over total, excluding unresolved slots. */
function citationShareOf(rows: readonly Record<string, unknown>[]): number | null {
  const resolved = rows.filter((row) => row.http_status !== null);
  const total = resolved.reduce((sum, row) => sum + Number(row.position_weight), 0);
  if (total === 0) return null;
  const owned = resolved
    .filter((row) => Boolean(row.is_owned))
    .reduce((sum, row) => sum + Number(row.position_weight), 0);
  return owned / total;
}
