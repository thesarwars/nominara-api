import type { ClientBase } from "pg";
import { alignmentRecommendationSchema, CLAIM_BEARING_NODE_TYPES, type GeoAnalysisWrite, type GeoFinding } from "../../../../contracts/analytics/index.js";
import { NotFoundError } from "../../../api/errors/domain-errors.js";
import { rankGeoLevers } from "../lever-rank.js";
import { writeGeoAnalysis } from "../persist-analysis.js";
import { isLowConfidence } from "../corpus/weights.js";
import { windowStartFor } from "../structure.js";

// STORY-192 - the alignment analysis (A1) written through STORY-062's `geo_analyses` layer, so it reaches the digest and the levers.
//
// `writeGeoAnalysis` is the ONE write path into the table: it validates the write contract (every finding evidenced and terminating in a task
// rule or a no-action verdict; an insufficient analysis publishes only its reason) and upserts, so a recompute REPLACES. After it, the levers
// of the window are re-ranked, as the daily rollup does.
//
// WHAT IS WRITTEN. `geo_analyses` is keyed by (project, analysis, window), not by session: the row speaks for the LATEST finished session of the
// project (the daily window is 30 days, the canonical one). Per-session detail lives on `geo_alignments` and in the payload.
//   score    the page's percentile among the documents engines cite (0-100); null when the page was not measured. Alignment is never a bare score.
//   finding  one per SHOWN recommendation (at most three, already suppressed for a thin corpus), naming the concept, how many cited documents
//            carry it and the source it came from. A concept that needs a human check says so in the finding. No generated prose.
//   no gap   one no-action finding, so the analysis says "nothing to add" rather than going silent - ONLY for a page that was measured and had no
//            missing concept. A page with no readable text, or missing concepts that could not be ranked, is insufficient with its reason.
//   thin corpus  fewer than the minimum passages is stated on the score's label (low confidence), not left for the reader to infer.
//   no corpus  an insufficient analysis with its reason and no score, no finding, no lever.

/** The task rule an alignment finding names (migration 0176; seeded disabled until the owner decides). */
export const ALIGNMENT_TASK_RULE = "TG-ALIGNMENT-NODE";
export const ALIGNMENT_WINDOW_DAYS = 30 as const;
/** At most this many findings: a digest that lists everything ranks nothing. */
const MAX_FINDINGS = 3;
const SCORE_LABEL = "Percentile among the documents engines cite";

interface SessionRow {
  project_id: string;
  target_url: string;
  centroid_source_count: number;
  percentile_vs_corpus: number | null;
  current_alignment: number | null;
  recommendations: unknown;
}

export async function writeAlignmentAnalysis(tx: ClientBase, sessionId: string, asOf: Date): Promise<void> {
  const found = await tx.query<SessionRow>(
    `SELECT project_id, target_url, centroid_source_count, percentile_vs_corpus, current_alignment, recommendations
       FROM geo_alignments WHERE id = $1 AND workspace_id = app.current_workspace()`,
    [sessionId],
  );
  const s = found.rows[0];
  if (s === undefined) throw new NotFoundError({ message: "no such alignment session" });

  const windowStart = windowStartFor(asOf, ALIGNMENT_WINDOW_DAYS);
  const base = { analysis: "alignment" as const, window_start: windowStart, window_days: ALIGNMENT_WINDOW_DAYS, evidence_cells: 0, evidence_passages: s.centroid_source_count };

  let write: GeoAnalysisWrite;
  if (s.centroid_source_count === 0) {
    write = {
      ...base, score: null, score_label: null, sufficient: false, lever_rank: null, findings: [],
      suppression_reason: "No cited passage has been embedded for this topic cluster yet, so the page could not be measured against what engines cite.",
    };
  } else if (s.current_alignment === null) {
    // The page was never measured (it has no readable text, so no chunk): "nothing is missing" would be a verdict on a page nobody looked at.
    write = {
      ...base, score: null, score_label: null, sufficient: false, lever_rank: null, findings: [],
      suppression_reason: "The page has no readable text, so it could not be measured against what engines cite.",
    };
  } else {
    const recommendations = alignmentRecommendationSchema.array().parse(s.recommendations);
    const shown = recommendations
      .filter((r) => r.priority_rank !== null && URL.canParse(r.evidence_url))
      .sort((a, b) => a.priority_rank! - b.priority_rank!)
      .slice(0, MAX_FINDINGS);
    if (shown.length === 0 && recommendations.length > 0) {
      // Concepts ARE missing, but none could be ranked (no modeled gain): saying "no gap" would be false, and a list of unranked concepts is not a finding.
      write = {
        ...base, score: null, score_label: null, sufficient: false, lever_rank: null, findings: [],
        suppression_reason: "Concepts the cited documents share are missing from the page, but none could be ranked by modeled gain, so no recommendation is shown.",
      };
    } else {
      const findings: GeoFinding[] =
        shown.length === 0
          ? [{
              id: "alignment-no-gap",
              severity: "info",
              headline: "No concept the cited documents share is missing from this page that would bring it closer to them.",
              evidence: [{ url: s.target_url, snippet: "The page measured against the passages engines cited for this topic cluster." }],
              no_action: true,
            }]
          : shown.map((r) => ({
              id: `alignment-node-${r.node_id}`,
              severity: (CLAIM_BEARING_NODE_TYPES as readonly string[]).includes(r.node_type) ? ("high" as const) : ("medium" as const),
              headline: `Cover "${r.phrase}" on the page: ${String(Math.round(r.corpus_doc_ratio * 100))}% of the documents engines cite for this topic mention it.`,
              ...(r.accuracy_warning === null ? {} : { detail: r.accuracy_warning }),
              evidence: [{ url: r.evidence_url, snippet: r.evidence_snippet, corpus_doc_ratio: r.corpus_doc_ratio }],
              metric: { name: "projected_gain", value: r.projected_gain ?? 0 },
              task_rule_code: ALIGNMENT_TASK_RULE,
            }));
      // aux-and-geo-analysis.md section 7: a thin corpus is marked low-confidence. The mark is on the score's own label, so it travels with the figure.
      const label = isLowConfidence(s.centroid_source_count) ? `${SCORE_LABEL} (low confidence: ${String(s.centroid_source_count)} cited passages)` : SCORE_LABEL;
      write = {
        ...base,
        score: s.percentile_vs_corpus,
        score_label: s.percentile_vs_corpus === null ? null : label,
        sufficient: true,
        suppression_reason: null,
        findings,
        lever_rank: null,
      };
    }
  }

  await writeGeoAnalysis(tx, s.project_id, write);
  await rankGeoLevers(tx, s.project_id, windowStart, ALIGNMENT_WINDOW_DAYS);
}
