import { describe, expect, it } from "vitest";
import { ALIGNMENT_CAVEAT, alignmentSessionPayloadSchema } from "./geo-alignment.schema.js";
import {
  ALIGNMENT_DRAFT_MAX_CHARS,
  createAlignmentPatchRequestSchema,
  openAlignmentRequestSchema,
  openAlignmentResponseSchema,
  updateAlignmentDraftRequestSchema,
} from "./geo-alignment-api.schema.js";

const uuid = "0198a1f0-0000-7000-8000-000000000001";
const recommendation = {
  id: uuid, kind: "semantic_node", node_id: uuid, node_type: "compliance", phrase: "soc 2 report", severity: null, corpus_doc_ratio: 0.6,
  present_in_content: false, projected_gain: 0.02, priority_rank: 1, guardrail: "phrase_only", requires_human_review: true,
  warning: "Only add this if it is true of your product.", evidence: [{ domain: "a.example", url: "https://a.example/p", snippet: "we hold a SOC 2 report" }],
  auto_insert: false,
} as const;
const ready = {
  alignment_id: uuid, target_url: "https://brand.test/p",
  prompt_cluster: { cluster_id: uuid, label: "Reporting tools", prompt_count: 3, engines: ["gemini"] },
  embedding: { model: "m", dims: 1536, storage: "halfvec" },
  centroid: { source_passage_count: 9, source_domains: ["a.example"], built_at: null },
  alignment: { baseline: 0.4, current: 0.4, target_band: [0.5, 0.7], percentile_vs_cited_docs: 20 },
  coverage: { required_nodes: 4, present_nodes: 2, coverage_ratio: 0.5 },
  content: { chunks: [{ chunk_index: 0, heading_path: [], token_count: 40, alignment: 0.4, weakest: true }] },
  low_confidence: false, estimate: { method: "additive_blend_estimate", confidence: "modeled", caveat: ALIGNMENT_CAVEAT },
  recommendations: [recommendation],
  projection: { naive_sum: 0.02, diminished_sum: 0.02, diminishing_returns_factor: 0.85, method: "additive_blend_estimate", confidence: "modeled", caveat: ALIGNMENT_CAVEAT },
  anti_filler_policy: { generation: "disabled", explanation: "Nominara returns phrases, structures, and schema - never generated prose." },
  status: "ready", status_reason: null, draft_status: null, live_content_md: "# CRM\n\nReporting for teams.",
} as const;

/** What a session that is not ready may carry: nothing measured. */
const UNMEASURED = {
  alignment: { baseline: null, current: null, target_band: null, percentile_vs_cited_docs: null },
  coverage: { required_nodes: null, present_nodes: null, coverage_ratio: null },
  content: { chunks: [] }, recommendations: [], projection: null, live_content_md: null,
} as const;

describe("STORY-192 - the alignment HTTP contracts", () => {
  it("AC pending - a pending session never carries a coverage, a recommendation or a projection as if final", () => {
    const pending = { ...ready, status: "pending", ...UNMEASURED };
    expect(alignmentSessionPayloadSchema.safeParse(pending).success).toBe(true);
    expect(alignmentSessionPayloadSchema.safeParse({ ...pending, coverage: { ...pending.coverage, coverage_ratio: 0.5 } }).success).toBe(false);
    expect(alignmentSessionPayloadSchema.safeParse({ ...pending, recommendations: [recommendation] }).success).toBe(false);
    expect(alignmentSessionPayloadSchema.safeParse({ ...pending, projection: ready.projection }).success).toBe(false);
    expect(alignmentSessionPayloadSchema.safeParse({ ...pending, content: ready.content }).success).toBe(false);
  });

  it("AC pending - review - no measured figure (baseline, current, percentile, band) is shown before the session is ready, whatever its state", () => {
    for (const status of ["pending", "stale", "failed"] as const) {
      const quiet = { ...ready, status, status_reason: status === "pending" ? null : "x", ...UNMEASURED };
      expect(alignmentSessionPayloadSchema.safeParse(quiet).success, status).toBe(true);
      for (const figure of [{ baseline: 0.4 }, { current: 0.4 }, { percentile_vs_cited_docs: 20 }, { target_band: [0.5, 0.7] }]) {
        expect(alignmentSessionPayloadSchema.safeParse({ ...quiet, alignment: { ...quiet.alignment, ...figure } }).success, `${status} ${Object.keys(figure)[0]!}`).toBe(false);
      }
    }
  });

  it("AC model mismatch - a stale or failed session states its reason, and a ready one states none", () => {
    const quiet = { ...ready, ...UNMEASURED };
    expect(alignmentSessionPayloadSchema.safeParse({ ...quiet, status: "stale", status_reason: "embedding_model_changed" }).success).toBe(true);
    expect(alignmentSessionPayloadSchema.safeParse({ ...quiet, status: "stale", status_reason: null }).success).toBe(false);
    expect(alignmentSessionPayloadSchema.safeParse({ ...quiet, status: "failed", status_reason: null }).success).toBe(false);
    expect(alignmentSessionPayloadSchema.safeParse({ ...ready, status_reason: "x" }).success).toBe(false);
    expect(alignmentSessionPayloadSchema.safeParse({ ...ready, status: "done" }).success).toBe(false);
  });

  it("AC draft - the draft status is one of pending, ready, failed or null (no draft)", () => {
    for (const draft_status of ["pending", "ready", "failed", null]) expect(alignmentSessionPayloadSchema.safeParse({ ...ready, draft_status }).success).toBe(true);
    expect(alignmentSessionPayloadSchema.safeParse({ ...ready, draft_status: "stale" }).success).toBe(false);
  });

  it("AC open - the request is strict: an unknown key is refused, and the page, project and cluster are all required", () => {
    const ok = { project_id: uuid, target_url: "https://brand.test/p", prompt_cluster_id: uuid };
    expect(openAlignmentRequestSchema.safeParse(ok).success).toBe(true);
    expect(openAlignmentRequestSchema.safeParse({ ...ok, engine_keys: ["gemini"] }).success).toBe(false);
    expect(openAlignmentRequestSchema.safeParse({ ...ok, target_url: "not a url" }).success).toBe(false);
    expect(openAlignmentRequestSchema.safeParse({ project_id: uuid, target_url: ok.target_url }).success).toBe(false);
    for (const target_url of ["ftp://brand.test/p", "file:///etc/passwd", "javascript:alert(1)", "data:text/html,x"]) {
      expect(openAlignmentRequestSchema.safeParse({ ...ok, target_url }).success, target_url).toBe(false);
    }
    expect(openAlignmentRequestSchema.safeParse({ ...ok, target_url: "HTTP://brand.test/p" }).success).toBe(true);
  });

  it("AC open - an uppercase id is lowercased at the boundary (STORY-150 AC7)", () => {
    const upper = uuid.toUpperCase();
    expect(openAlignmentRequestSchema.parse({ project_id: upper, target_url: "https://brand.test/p", prompt_cluster_id: upper })).toMatchObject({ project_id: uuid, prompt_cluster_id: uuid });
  });

  it("AC open - charges nothing: the 202 says pending, carries a poll pointer and 0 credits", () => {
    expect(openAlignmentResponseSchema.safeParse({ session_id: uuid, status: "pending", poll_url: `/v1/geo/alignment/${uuid}`, credits_charged: 0 }).success).toBe(true);
    expect(openAlignmentResponseSchema.safeParse({ session_id: uuid, status: "pending", poll_url: "/x", credits_charged: 1 }).success).toBe(false);
    expect(openAlignmentResponseSchema.safeParse({ session_id: uuid, status: "ready", poll_url: "/x", credits_charged: 0 }).success).toBe(false);
  });

  it("AC draft - the edit body is strict, non-empty and bounded; boundary values", () => {
    expect(updateAlignmentDraftRequestSchema.safeParse({ draft_content_md: "a" }).success).toBe(true);
    expect(updateAlignmentDraftRequestSchema.safeParse({ draft_content_md: "a".repeat(ALIGNMENT_DRAFT_MAX_CHARS) }).success).toBe(true);
    expect(updateAlignmentDraftRequestSchema.safeParse({ draft_content_md: "a".repeat(ALIGNMENT_DRAFT_MAX_CHARS + 1) }).success).toBe(false);
    expect(updateAlignmentDraftRequestSchema.safeParse({ draft_content_md: "" }).success).toBe(false);
    expect(updateAlignmentDraftRequestSchema.safeParse({ draft_content_md: "x", live_content_md: "y" }).success).toBe(false);
  });

  it("AC patch - the body is empty and strict: nothing can be chosen, so nothing may be sent", () => {
    expect(createAlignmentPatchRequestSchema.safeParse({}).success).toBe(true);
    expect(createAlignmentPatchRequestSchema.safeParse({ content: "generated prose" }).success).toBe(false);
  });
});
