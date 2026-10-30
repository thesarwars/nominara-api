import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { toolRunDetailSchema, toolRunSchema } from "../../../contracts/tools/index.js";
import { toolInputHash } from "./input-hash.js";
import { toolConversionPlan } from "./conversion.js";
import { toolPresentation, DID_NOT_CHECK, NOT_TRACKED_NOTE } from "./presentation.js";
import { deriveToolRunOutcome } from "./run-outcome.js";
import { toolSnapshotExpiresAt } from "./retention-window.js";

// STORY-078 - the pure rules of the shared tool core. Scenario numbers are the story's Test scenarios table.

describe("STORY-078 · scenario 6 - input_hash is a normalised digest over tool, inputs and engine set", () => {
  const base = { brandName: "Acme", queryText: "best crm", engineKeys: ["perplexity", "chatgpt"] };

  it("scenario 6 - the same request from two callers gives an identical hash, however it is spelled", () => {
    const a = toolInputHash("visibility_scan", base);
    const b = toolInputHash("visibility_scan", { brandName: "  acme ", queryText: "Best   CRM", engineKeys: ["chatgpt", "perplexity", "chatgpt"] });
    expect(a.equals(b)).toBe(true);
    expect(a).toHaveLength(32);
  });

  it("scenario 6 - a different tool, brand, query, engine set or locale gives a different hash", () => {
    const a = toolInputHash("visibility_scan", base);
    expect(toolInputHash("competitor_finder", base).equals(a)).toBe(false);
    expect(toolInputHash("visibility_scan", { ...base, brandName: "Other" }).equals(a)).toBe(false);
    expect(toolInputHash("visibility_scan", { ...base, queryText: "best erp" }).equals(a)).toBe(false);
    expect(toolInputHash("visibility_scan", { ...base, engineKeys: ["chatgpt"] }).equals(a)).toBe(false);
    expect(toolInputHash("visibility_scan", { ...base, locale: "de-DE" }).equals(a)).toBe(false);
  });

  it("scenario 6 - the locale default is part of the hash, so an omitted locale equals en-US", () => {
    expect(toolInputHash("visibility_scan", base).equals(toolInputHash("visibility_scan", { ...base, locale: "en-US" }))).toBe(true);
  });

  it("scenario 6 - a URL is compared by host, path and query, not by case, fragment or a trailing slash", () => {
    const a = toolInputHash("aux_audit", { targetUrl: "https://Example.com/pricing/" });
    expect(toolInputHash("aux_audit", { targetUrl: "https://example.com/pricing#top" }).equals(a)).toBe(true);
    expect(toolInputHash("aux_audit", { targetUrl: "https://example.com/pricing?x=1" }).equals(a)).toBe(false);
    expect(toolInputHash("aux_audit", { targetUrl: "https://example.com/other" }).equals(a)).toBe(false);
  });

  it("scenario 6 - the prompt set is a set: order and duplicates do not change the hash, content does", () => {
    const a = toolInputHash("prompt_research", { promptTexts: ["b?", "a?"] });
    expect(toolInputHash("prompt_research", { promptTexts: ["A?", "b?", "a?"] }).equals(a)).toBe(true);
    expect(toolInputHash("prompt_research", { promptTexts: ["a?"] }).equals(a)).toBe(false);
  });

  it("scenario 6 - a unicode-equivalent brand name hashes the same (NFC)", () => {
    const decomposed = "Café";
    const composed = "Café";
    expect(toolInputHash("competitor_finder", { brandUrl: "https://x.test", brandName: decomposed }).equals(toolInputHash("competitor_finder", { brandUrl: "https://x.test", brandName: composed }))).toBe(true);
  });

  it("scenario 6 - the null path: an absent input and an empty one hash alike, and nothing throws on an all-empty request", () => {
    expect(toolInputHash("schema_builder", {}).equals(toolInputHash("schema_builder", { brandName: "  ", promptTexts: [] }))).toBe(true);
  });

  it("scenario 6 - a compare pair is ordered: base and compare are not interchangeable", () => {
    const x = "0197c1e0-0000-7000-8000-000000000001";
    const y = "0197c1e0-0000-7000-8000-000000000002";
    expect(toolInputHash("compare_runs", { diffBaseRunId: x, diffCompareRunId: y }).equals(toolInputHash("compare_runs", { diffBaseRunId: y, diffCompareRunId: x }))).toBe(false);
  });
});

describe("STORY-078 · scenarios 9 and 10 - what a finished run is called and charged", () => {
  const captureBacked = ["perplexity", "chatgpt"];

  it("scenario 10 - every engine answered: completed, charged in full", () => {
    expect(deriveToolRunOutcome({ engineKeys: captureBacked, enginesSucceeded: captureBacked, enginesFailed: [] })).toEqual({ status: "completed", refund: false });
  });

  it("scenario 10 - some engines failed: partial, charged in full (no refund), the arrays say which", () => {
    expect(deriveToolRunOutcome({ engineKeys: captureBacked, enginesSucceeded: ["perplexity"], enginesFailed: ["chatgpt"] })).toEqual({ status: "partial", refund: false });
  });

  it("scenario 9 - nothing captured: failed and refunded in full", () => {
    expect(deriveToolRunOutcome({ engineKeys: captureBacked, enginesSucceeded: [], enginesFailed: captureBacked })).toEqual({ status: "failed", refund: true });
  });

  it("scenario 9 - nothing captured and nothing recorded as failed is still a full refund, never a charge", () => {
    expect(deriveToolRunOutcome({ engineKeys: captureBacked, enginesSucceeded: [], enginesFailed: [] })).toEqual({ status: "failed", refund: true });
  });

  it("scenario 7 - a tool with no engines is completed unless its own run failed; a failed one is refunded", () => {
    expect(deriveToolRunOutcome({ engineKeys: [], enginesSucceeded: [], enginesFailed: [] })).toEqual({ status: "completed", refund: false });
    expect(deriveToolRunOutcome({ engineKeys: [], enginesSucceeded: [], enginesFailed: [], failed: true })).toEqual({ status: "failed", refund: true });
  });

  it("scenario 10 - an engine reported that was never part of the run is refused, not counted", () => {
    expect(() => deriveToolRunOutcome({ engineKeys: captureBacked, enginesSucceeded: ["gemini"], enginesFailed: [] })).toThrow(/not in the run's engine set/);
  });
});

describe("STORY-078 · scenario 8 - expires_at comes from the plan's retention, at insert", () => {
  const now = new Date("2026-10-30T12:00:00.000Z");
  const plan = (days: unknown) => ({ "retention.raw_captures_days": { value: days } });

  it("scenario 8 - the plan's window in days after the insert instant", () => {
    expect(toolSnapshotExpiresAt(plan(30), now).toISOString()).toBe("2026-11-29T12:00:00.000Z");
    expect(toolSnapshotExpiresAt(plan(400), now).toISOString()).toBe("2027-12-04T12:00:00.000Z");
  });

  it("scenario 8 - a plan with no usable window fails closed rather than minting a run that never expires or expires now", () => {
    for (const bad of [null, undefined, 0, -5, 1.5, "unlimited", "30"]) {
      expect(() => toolSnapshotExpiresAt(plan(bad), now)).toThrow(/retention/);
    }
    expect(() => toolSnapshotExpiresAt({}, now)).toThrow(/retention/);
  });
});

describe("STORY-078 · scenario 22 - every envelope carries the not-tracked marker, the did-not-check line, and flags estimates", () => {
  const headline = { sov_estimate: 0.4, citation_count: 0, sentiment_label: "positive", brand_present: true, aux_score: null, entities_found: null, pages_scanned: null, items_kept: null } as const;

  it("scenario 22 - all six tools state what they did not check, in one line", () => {
    for (const tool of ["visibility_scan", "prompt_research", "competitor_finder", "aux_audit", "schema_builder", "compare_runs"] as const) {
      const p = toolPresentation(tool, headline);
      expect(p.not_tracked).toBe(true);
      expect(p.not_tracked_note).toBe(NOT_TRACKED_NOTE);
      expect(p.did_not_check).toBe(DID_NOT_CHECK[tool]);
      expect(p.did_not_check.length).toBeGreaterThan(10);
      expect(p.did_not_check).not.toContain("\n");
    }
  });

  it("scenario 22 - sampled headline figures are flagged as estimates, and only the ones that are present", () => {
    expect(toolPresentation("visibility_scan", headline).estimated_fields).toEqual(["sov_estimate", "citation_count", "sentiment_label", "brand_present"]);
    expect(toolPresentation("visibility_scan", { ...headline, sov_estimate: null }).estimated_fields).not.toContain("sov_estimate");
  });

  it("scenario 22 - a measured zero is still flagged (0 is not absent)", () => {
    expect(toolPresentation("visibility_scan", { ...headline, citation_count: 0 }).estimated_fields).toContain("citation_count");
  });

  it("scenario 22 - a deterministic tool flags no estimates", () => {
    expect(toolPresentation("aux_audit", { ...headline, aux_score: 80 }).estimated_fields).toEqual([]);
    expect(toolPresentation("schema_builder", headline).estimated_fields).toEqual([]);
  });
});

describe("STORY-078 · scenarios 18 and 21 - one conversion contract", () => {
  const run = (over: Record<string, unknown> = {}) => ({
    tool_key: "visibility_scan" as const,
    status: "completed" as const,
    brand_name: "Acme",
    brand_url: "https://acme.test",
    target_url: null,
    query_text: "best crm",
    prompt_texts: null,
    converted_project_id: null,
    ...over,
  });

  it("scenario 18 - every one of the six tools has an answer; none throws", () => {
    for (const tool of ["visibility_scan", "prompt_research", "competitor_finder", "aux_audit", "schema_builder", "compare_runs"] as const) {
      expect(() => toolConversionPlan(run({ tool_key: tool }))).not.toThrow();
    }
  });

  it("scenario 18 - copies whichever inputs the tool produced: name, URL, and the query as a prompt", () => {
    expect(toolConversionPlan(run())).toMatchObject({ state: "available", reason: null, prefill: { project_name: "Acme", root_url: "https://acme.test", prompts: ["best crm"] } });
  });

  it("scenario 18 - a prompt-research run carries its prompts, de-duplicated, and takes the audit URL when there is no brand URL", () => {
    const plan = toolConversionPlan(run({ tool_key: "prompt_research", brand_url: null, target_url: "https://acme.test/x", query_text: null, prompt_texts: ["a?", "a?", "b?"] }));
    expect(plan.prefill.prompts).toEqual(["a?", "b?"]);
    expect(plan.prefill.root_url).toBe("https://acme.test/x");
  });

  it("scenario 18 - no URL anywhere is 'unavailable: no_url' (the caller must supply one), never a guessed URL", () => {
    expect(toolConversionPlan(run({ brand_url: null }))).toMatchObject({ state: "unavailable", reason: "no_url", prefill: { root_url: null } });
  });

  it("scenario 20 - a converted run reports 'converted', whatever else is true of it", () => {
    expect(toolConversionPlan(run({ converted_project_id: "0197c1e0-0000-7000-8000-000000000001", status: "failed" })).state).toBe("converted");
  });

  it("scenario 18 - a run still running or one that captured nothing cannot seed a project; an expired run can (its inputs are kept)", () => {
    expect(toolConversionPlan(run({ status: "running" }))).toMatchObject({ state: "unavailable", reason: "run_not_finished" });
    expect(toolConversionPlan(run({ status: "failed" }))).toMatchObject({ state: "unavailable", reason: "run_failed" });
    expect(toolConversionPlan(run({ status: "expired" })).state).toBe("available");
    expect(toolConversionPlan(run({ status: "partial" })).state).toBe("available");
  });

  it("scenario 21 - converting is free: the contract's credit figure is the literal 0", () => {
    expect(toolConversionPlan(run()).credits).toBe(0);
  });
});

describe("STORY-078 · contracts", () => {
  it("a run row parses through the wire schema and refuses an unknown key (.strict)", () => {
    const row = {
      id: "0197c1e0-0000-7000-8000-000000000001",
      tool_key: "visibility_scan",
      status: "completed",
      created_by: null,
      created_at: "2026-10-30T12:00:00.000Z",
      expires_at: "2026-11-29T12:00:00.000Z",
      pinned: false,
      inputs: { brand_name: "Acme", brand_url: null, target_url: null, query_text: "q", prompt_texts: null, engine_keys: ["gemini"], locale: "en-US" },
      headline: { sov_estimate: 0, citation_count: 0, sentiment_label: null, brand_present: false, aux_score: null, entities_found: null, pages_scanned: null, items_kept: null },
      engines_succeeded: ["gemini"],
      engines_failed: [],
      credits_charged: 10,
      duration_ms: null,
      cache_layer: "live",
      error_code: null,
      diff_base_run_id: null,
      diff_compare_run_id: null,
      converted_project_id: null,
      converted_at: null,
      presentation: toolPresentation("visibility_scan", { sov_estimate: 0, citation_count: 0, sentiment_label: null, brand_present: false, aux_score: null, entities_found: null, pages_scanned: null, items_kept: null }),
      expired: null,
    };
    expect(toolRunSchema.safeParse(row).success).toBe(true);
    expect(toolRunSchema.safeParse({ ...row, extra: 1 }).success).toBe(false);
    const conversion = toolConversionPlan({ tool_key: "visibility_scan", status: "completed", brand_name: "Acme", brand_url: null, target_url: null, query_text: "q", prompt_texts: null, converted_project_id: null });
    expect(toolRunDetailSchema.safeParse({ ...row, result: null, conversion }).success).toBe(true);
    expect(toolRunDetailSchema.safeParse({ ...row, result: [], conversion }).success).toBe(false);
  });
});

// Scenario 5 - "the tools module does not import any fact repository". Asserted over the SOURCE of the tools module and its lib,
// because an import is the only way a tool could reach a fact table (KAD-04: no repository layer, so the fact tables'
// owners are services and SQL strings). The isolation suite asserts the runtime half: zero fact rows after a tool.
describe("STORY-078 · scenario 5 - no tool writes answer_captures, mention_facts or citation_facts", () => {
  const roots = [path.resolve(import.meta.dirname, "../../modules/tools"), path.resolve(import.meta.dirname)];
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) return files(full);
      return /\.ts$/.test(name) && !/\.spec\.ts$/.test(name) ? [full] : [];
    });
  const sources = roots.flatMap(files);

  it("scenario 5 - there are tool sources to scan (the assertion is not vacuous)", () => {
    expect(sources.length).toBeGreaterThan(5);
  });

  it("scenario 5 - no tool source names a fact table or imports a module that owns one", () => {
    const forbiddenTables = /\b(answer_captures|mention_facts|citation_facts|capture_runs|capture_results)\b/;
    const forbiddenImports = /from\s+["'][^"']*\/(modules\/tracking|lib\/capture|lib\/parser|modules\/analytics)\//;
    for (const file of sources) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(forbiddenTables);
      expect(text, file).not.toMatch(forbiddenImports);
    }
  });
});
