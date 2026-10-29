import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ALIGNMENT_CAVEAT,
  CLAIM_BEARING_NODE_TYPES,
  alignmentRecommendationSchema,
  alignmentSessionPayloadSchema,
} from "./geo-alignment.schema.js";

const uuid = "0198a1f0-0000-7000-8000-000000000001";
const recommendation = {
  node_id: uuid, phrase: "soc 2 report", node_type: "compliance", corpus_doc_ratio: 0.6, projected_gain: 0.02, priority_rank: 1,
  evidence_url: "https://a.example/p", evidence_snippet: "we hold a SOC 2 report", requires_human_review: true,
  accuracy_warning: "Only add this if it is true of your product.", auto_insert: false,
} as const;
const payload = {
  session_id: uuid, target_url: "https://brand.test/p", prompt_cluster_id: null, embedding_model: "m", baseline_alignment: 0.4, current_alignment: 0.4,
  target_band: { low: 0.5, high: 0.7 }, percentile_vs_corpus: 20, coverage_ratio: 0.5, centroid_source_count: 9, centroid_domains: ["a.example"],
  low_confidence: false, estimate: { method: "additive_blend_estimate", confidence: "modeled", caveat: ALIGNMENT_CAVEAT },
  recommendations: [recommendation], projection: { naive_sum: 0.02, diminished_sum: 0.02, diminishing_returns_factor: 0.85 },
  generation: "disabled",
} as const;

describe("STORY-059 - alignment session payload contract", () => {
  it("scenario 10 - AC10 - the payload carries the estimate labelling and declares generation disabled", () => {
    const parsed = alignmentSessionPayloadSchema.parse(payload);
    expect(parsed.estimate).toEqual({ method: "additive_blend_estimate", confidence: "modeled", caveat: ALIGNMENT_CAVEAT });
    expect(parsed.generation).toBe("disabled");
  });

  it("scenario 10 - AC10 - a payload without the estimate label, or with another method or confidence, is not a valid payload", () => {
    const { estimate: _estimate, ...without } = payload;
    expect(alignmentSessionPayloadSchema.safeParse(without).success).toBe(false);
    expect(alignmentSessionPayloadSchema.safeParse({ ...payload, estimate: { ...payload.estimate, confidence: "measured" } }).success).toBe(false);
    expect(alignmentSessionPayloadSchema.safeParse({ ...payload, estimate: { ...payload.estimate, method: "ranking_guarantee" } }).success).toBe(false);
  });

  it("scenario 9 - review - the projection has no page-level projected_alignment (chunk gains are not page units), and one is refused", () => {
    expect(Object.keys(alignmentSessionPayloadSchema.parse(payload).projection!).sort()).toEqual(["diminished_sum", "diminishing_returns_factor", "naive_sum"]);
    expect(alignmentSessionPayloadSchema.safeParse({ ...payload, projection: { ...payload.projection, projected_alignment: 0.42 } }).success).toBe(false);
  });

  it("scenario 13 - AC12 - generation cannot be declared enabled, and an unknown key is refused", () => {
    expect(alignmentSessionPayloadSchema.safeParse({ ...payload, generation: "enabled" }).success).toBe(false);
    expect(alignmentSessionPayloadSchema.safeParse({ ...payload, generation: true }).success).toBe(false);
    expect(alignmentSessionPayloadSchema.safeParse({ ...payload, generate_url: "/v1/generate" }).success).toBe(false);
  });

  it("scenario 12 - AC13 - a recommendation is never auto-inserted, and a flagged node must carry its warning", () => {
    expect(alignmentRecommendationSchema.safeParse({ ...recommendation, auto_insert: true }).success).toBe(false);
    expect(alignmentRecommendationSchema.safeParse({ ...recommendation, accuracy_warning: null }).success).toBe(false);
    expect(alignmentRecommendationSchema.safeParse({ ...recommendation, requires_human_review: false }).success).toBe(false);
    expect(alignmentRecommendationSchema.safeParse({ ...recommendation, node_type: "capability", requires_human_review: false, accuracy_warning: null }).success).toBe(true);
  });

  it("review - AC13 - a claim-bearing node cannot be declared without review, whatever its warning: the flag is not the writer's choice", () => {
    for (const node_type of CLAIM_BEARING_NODE_TYPES) {
      expect(alignmentRecommendationSchema.safeParse({ ...recommendation, node_type, requires_human_review: false, accuracy_warning: null }).success, node_type).toBe(false);
      expect(alignmentRecommendationSchema.safeParse({ ...recommendation, node_type, requires_human_review: true, accuracy_warning: "Check this." }).success, node_type).toBe(true);
    }
  });

  it("scenario 12 - AC13 - compliance, metric and pricing are the claim-bearing types", () => {
    expect([...CLAIM_BEARING_NODE_TYPES].sort()).toEqual(["compliance", "metric", "pricing_term"]);
  });

  it("scenario 7 - AC8 - a node with no evidence is not a valid recommendation", () => {
    expect(alignmentRecommendationSchema.safeParse({ ...recommendation, evidence_url: "" }).success).toBe(false);
    expect(alignmentRecommendationSchema.safeParse({ ...recommendation, evidence_snippet: "" }).success).toBe(false);
  });

  it("the absent is null, never 0: a session with nothing measured carries nulls", () => {
    const empty = { ...payload, baseline_alignment: null, current_alignment: null, target_band: null, percentile_vs_corpus: null, coverage_ratio: null, recommendations: [], projection: null };
    const parsed = alignmentSessionPayloadSchema.parse(empty);
    expect(parsed.coverage_ratio).toBeNull();
    expect(parsed.target_band).toBeNull();
  });

  it("scenario 13 - AC12 - no generation, editor or rewrite route exists anywhere in src/modules or the generated OpenAPI document", () => {
    const root = path.resolve(import.meta.dirname, "..", "..");
    const openapi = readFileSync(path.join(root, "contracts", "openapi.generated.json"), "utf8");
    const paths = Object.keys((JSON.parse(openapi) as { paths: Record<string, unknown> }).paths);
    expect(paths.filter((p) => /generat|rewrite|suggest-copy|draft-copy|autowrite|editor/i.test(p) && /geo|alignment|node|semantic/i.test(p))).toEqual([]);
    const sources: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (entry.endsWith(".controller.ts")) sources.push(readFileSync(full, "utf8"));
      }
    };
    walk(path.join(root, "src", "modules"));
    expect(sources.length).toBeGreaterThan(0);
    const routes = sources.flatMap((source) => [...source.matchAll(/@(?:Get|Post|Put|Patch|Delete)\(\s*["'`]([^"'`]*)["'`]/g)].map((m) => m[1]!));
    expect(routes.filter((r) => /(alignment|semantic|geo).*(generat|rewrite|autowrite|draft-copy)|(generat|rewrite|autowrite).*(alignment|semantic|geo)/i.test(r))).toEqual([]);
  });

  it("AC10 - NFR-OPT-02 - the caveat and the contract make no ranking-guarantee claim", () => {
    const text = readFileSync(path.join(import.meta.dirname, "geo-alignment.schema.ts"), "utf8").replace(/\/\/.*$/gm, "");
    const banned = /\b(guarantee[sd]?|will\s+rank|rank(?:s|ing)?\s+(?:higher|#?1|first)|ensures?\s+(?:citation|ranking)|boosts?\s+your\s+rank)/i;
    expect(ALIGNMENT_CAVEAT).not.toMatch(banned);
    expect(text).not.toMatch(banned);
  });
});
