import { Inject, Injectable, Logger } from "@nestjs/common";
import { SpanStatusCode, trace, type Span } from "@opentelemetry/api";
import type { ClientBase } from "pg";
import type { ReparseResponse, ReparseSnapshot } from "../../../contracts/tracking/index.js";
import { NotFoundError, PreconditionUnmetError } from "../../api/errors/domain-errors.js";
import { loadParseContext, parseCapture, persistParse, type CaptureRow } from "../../lib/parser/parse-capture.js";
import type { ResolvedCitation } from "../../lib/parser/citations.js";
import { markDateDirty, type DirtyEntry } from "../../lib/rollup/dirty-dates.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { assertProjectInScope } from "../../tenancy/project-scope.js";
import { currentTenantStore } from "../../tenancy/tenant-context.js";
import { assertWithinRawRetention } from "./raw-retention.js";

// STORY-034 AC9 - `POST /v1/results/{id}/reparse`: "re-run the parser on the stored capture, with a before-and-after diff, and charge
// nothing" (tracking-engine.md section 8: all scoring and parser changes ship as a re-parse, never as a re-capture).
//
// OWNER DECISION 2026-10-23 (the planner's open questions, both answered): a customer route (FR-PA-08), permission-gated; the
// corrected facts are SAVED (not a dry run), the capture's workspace-local date is marked dirty so the rollup follows, it is free
// and it is audited. The diff is the proof of what moved.
//
// THE REQUEST PATH MAKES NO EXTERNAL CALL (KAD-06, NFR-ARCH-04), and two choices follow from that, both worth stating:
//
//   1. THE ANSWER IS READ FROM `answer_captures.payload`, NOT FROM THE RAW OBJECT. STORY-181 dual-writes: the object is the verbatim
//      retained copy and `payload` keeps the same text. Reading S3 here would hold the request's tenant transaction open across an
//      await on object storage, and a request handler cannot end that transaction (the interceptor owns it). The two copies are the
//      same bytes by construction (written in one step); the capture worker's parse reads the object.
//   2. CITATIONS ARE NOT RE-FETCHED. Resolving a citation follows a redirect on a third party's site. A re-parse re-uses the
//      resolution already recorded for each citation (status, final URL, `resolved_at`); a URL the improved extractor finds that
//      was never resolved is stored unresolved (`http_status` NULL, excluded from share), exactly like any unresolved citation,
//      and the next capture resolves it.
//
// NOT CONSULTED: the L3 short-circuit. A re-parse exists to recompute; "the prior answer is still good" is what it is asked to doubt.

/** Writes a workspace-local date into the `rollup_dirty` set (STORY-042). Injected so the request path never builds a Valkey client of its own. */
export type DirtyMarker = (entry: DirtyEntry) => Promise<void>;
export const REPARSE_DIRTY_MARKER = Symbol("REPARSE_DIRTY_MARKER");

const tracer = trace.getTracer("nominara.tracking");
const logger = new Logger("tracking.reparse");

interface CaptureRecord {
  id: string;
  project_id: string;
  prompt_id: string;
  engine_key: string;
  captured_at: Date;
  status: "captured" | "parsed" | "failed" | "blocked" | "skipped";
  flags: string[];
  payload: { text?: unknown; structured_citations?: unknown; structured_elements?: unknown; raw_expired?: unknown } | null;
}

interface SnapshotRow {
  normalizer_version: string;
  scoring_version: string;
  brand_present: boolean | null;
  brand_rank_position: number | null;
  sov: number | null;
  sentiment_label: ReparseSnapshot["sentiment_label"];
  sentiment_score: number | null;
  citation_count: number;
  owned_citation_count: number;
}

interface EntityRow {
  entity_type: "brand" | "competitor" | "other";
  entity_id: string | null;
  entity_label: string;
  occurrences: string;
  prominence: number;
  sentiment_label: "positive" | "neutral" | "negative";
  position_class: string | null;
}

interface RecordedResolution {
  readonly http_status: number | null;
  readonly normalized_url: string;
  readonly resolved_at: Date | null;
}

@Injectable()
export class ReparseService {
  constructor(@Inject(REPARSE_DIRTY_MARKER) private readonly markDirty: DirtyMarker) {}

  reparse(resultId: string): Promise<ReparseResponse> {
    return tracer.startActiveSpan("tracking.reparse", async (span) => {
      try {
        const response = await this.run(resultId, span);
        span.setAttribute("nominara.tracking.reparse.changed", response.changed);
        return response;
      } catch (error) {
        span.recordException(error instanceof Error ? error : new Error("reparse failed"));
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  private async run(resultId: string, _span: Span): Promise<ReparseResponse> {
    const store = currentTenantStore();
    if (store === undefined) throw new Error("ReparseService requires an active tenant context");
    const client = store.client;
    const workspaceId = store.context.workspaceId;

    // FOR UPDATE: two re-parses of one capture (a double click, a retried request) serialise here instead of interleaving their
    // delete-then-insert. RLS makes another workspace's row absent.
    const found = await client.query<CaptureRecord>(
      `SELECT id, project_id, prompt_id, engine_key, captured_at, status, flags, payload
         FROM answer_captures
        WHERE id = $1
        FOR UPDATE`,
      [resultId],
    );
    const capture = found.rows[0];
    if (capture === undefined) throw new NotFoundError({ message: "no such result" });
    // The id names a result, not a project: a scoped member is checked against the row's own project (403, never 404).
    await assertProjectInScope(client, capture.project_id);
    // Past retention the stored answer is gone by policy: 507, and the facts already stored are left exactly as they are.
    await assertWithinRawRetention(client, workspaceId, { capturedAt: capture.captured_at, rawExpired: capture.payload?.raw_expired }, "reparse");

    const text = capture.payload?.text;
    if (capture.status === "failed" || capture.status === "blocked" || typeof text !== "string" || text.length === 0) {
      // A cell that was never captured, a refusal, and a reused row whose text lives with its source have no stored answer of their
      // own to re-run. Said plainly, not parsed as an empty answer (which would write "absent" facts for a question never answered).
      throw new PreconditionUnmetError({ message: "this capture has no stored answer to re-parse" });
    }

    const before = await snapshot(client, capture.id);

    const recorded = await recordedResolutions(client, capture.id);
    const { context, aliasFingerprint } = await loadParseContext(client, capture.project_id);
    const row: CaptureRow = {
      resultId: capture.id,
      workspaceId,
      projectId: capture.project_id,
      promptId: capture.prompt_id,
      engineKey: capture.engine_key,
      capturedAt: capture.captured_at,
      text,
      flags: capture.flags,
      ...structuredOf(capture),
    };
    const parsed = await parseCapture(row, {
      ...context,
      fetch: (url) => {
        const hit = recorded.get(url);
        if (hit === undefined || hit.http_status === null) return Promise.reject(new Error("no recorded resolution"));
        return Promise.resolve({ status: hit.http_status, finalUrl: hit.normalized_url });
      },
    });
    const result = { ...parsed, citations: parsed.citations.map((citation) => keepRecordedResolvedAt(citation, recorded)) };

    await persistParse(client, row, result, aliasFingerprint);
    await markDateDirty(client, { workspaceId, projectId: capture.project_id, capturedAt: capture.captured_at }, this.markDirty, logger);

    const after = await snapshot(client, capture.id);
    const changed = JSON.stringify(factsOf(before)) !== JSON.stringify(factsOf(after));
    incrementCounter("nominara_tracking_reparse_total", { outcome: changed ? "changed" : "unchanged" });
    // IDs and counts only: never the answer, an entity label, or a citation URL.
    logger.log({
      event: "tracking.reparse",
      workspace_id: workspaceId,
      result_id: capture.id,
      changed,
      entities_before: before.entities.length,
      entities_after: after.entities.length,
    });

    return { result_id: capture.id, scoring_version: after.scoring_version, changed, credits_charged: 0, before, after };
  }
}

function structuredOf(capture: CaptureRecord): Partial<Pick<CaptureRow, "structuredCitations" | "structuredElements">> {
  const citations = capture.payload?.structured_citations;
  const elements = capture.payload?.structured_elements;
  return {
    ...(Array.isArray(citations) ? { structuredCitations: citations as NonNullable<CaptureRow["structuredCitations"]> } : {}),
    ...(Array.isArray(elements) ? { structuredElements: elements as NonNullable<CaptureRow["structuredElements"]> } : {}),
  };
}

async function recordedResolutions(client: ClientBase, resultId: string): Promise<Map<string, RecordedResolution>> {
  const rows = await client.query<{ raw_url: string } & RecordedResolution>(
    "SELECT raw_url, normalized_url, http_status, resolved_at FROM citation_facts WHERE result_id = $1",
    [resultId],
  );
  return new Map(rows.rows.map((row) => [row.raw_url, { http_status: row.http_status, normalized_url: row.normalized_url, resolved_at: row.resolved_at }]));
}

/** `resolveCitation` stamps "now" on a resolution it did not make; the recorded time is when the citation really was resolved. */
function keepRecordedResolvedAt(citation: ResolvedCitation, recorded: ReadonlyMap<string, RecordedResolution>): ResolvedCitation {
  const hit = recorded.get(citation.rawUrl);
  if (hit === undefined || hit.http_status === null || citation.httpStatus === null) return citation;
  return { ...citation, resolvedAt: hit.resolved_at === null ? null : hit.resolved_at.toISOString() };
}

/** The same shape either side of the write: the capture's stored figures and its entities (one entry per entity, first occurrence's attributes). */
async function snapshot(client: ClientBase, resultId: string): Promise<ReparseSnapshot> {
  const capture = await client.query<SnapshotRow>(
    `SELECT normalizer_version, scoring_version, brand_present, brand_rank_position, sov, sentiment_label, sentiment_score,
            citation_count, owned_citation_count
       FROM answer_captures WHERE id = $1`,
    [resultId],
  );
  const row = capture.rows[0]!;
  const entities = await client.query<EntityRow>(
    `SELECT entity_type, entity_id, entity_label, occurrences, prominence, sentiment_label, position_class
       FROM (
         SELECT DISTINCT ON (entity_type, COALESCE(entity_id::text, entity_label))
                m.entity_type, m.entity_id, m.entity_label, m.prominence, m.sentiment_label, m.position_class,
                count(*) OVER (PARTITION BY m.entity_type, COALESCE(m.entity_id::text, m.entity_label)) AS occurrences
           FROM mention_facts m
          WHERE m.result_id = $1
          ORDER BY m.entity_type, COALESCE(m.entity_id::text, m.entity_label), m.char_start
       ) t
      ORDER BY entity_type, entity_label`,
    [resultId],
  );
  return {
    normalizer_version: row.normalizer_version,
    scoring_version: row.scoring_version,
    brand_present: row.brand_present,
    brand_rank_position: row.brand_rank_position,
    share_of_voice: row.sov,
    sentiment_label: row.sentiment_label,
    sentiment_score: row.sentiment_score,
    citation_count: row.citation_count,
    owned_citation_count: row.owned_citation_count,
    entities: entities.rows.map((entity) => ({
      entity_type: entity.entity_type,
      entity_id: entity.entity_id,
      label: entity.entity_label,
      occurrences: Number(entity.occurrences),
      prominence: entity.prominence,
      sentiment_label: entity.sentiment_label,
      position_class: entity.position_class,
    })),
  };
}

/** What `changed` compares: the FACTS. A version stamp moving on its own is visible in the snapshots and is not a change of fact. */
function factsOf(snap: ReparseSnapshot): Omit<ReparseSnapshot, "normalizer_version" | "scoring_version"> {
  const { normalizer_version: _n, scoring_version: _s, ...facts } = snap;
  return facts;
}
