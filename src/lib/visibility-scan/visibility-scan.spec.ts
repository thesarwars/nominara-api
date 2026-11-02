import { describe, expect, it, vi } from "vitest";
import {
  scanStreamCompletedSchema,
  scanStreamEngineResultSchema,
  visibilityScanRequestSchema,
  visibilityScanResultSchema,
} from "../../../contracts/tools/index.js";
import { selectScanEngines, SCAN_EXCLUDED_ENGINES } from "./engine-set.js";
import { aggregateScan, failureFor, parseScanAnswer, toEngineResult } from "./scan-result.js";
import { runVisibilityScan, ScanCaptureError, type ScanPorts, type ScanPublished } from "./run-scan.js";

// STORY-079 - the pure core of the Visibility Scan. Scenario numbers are the story's Test scenarios table.

const ANSWER = "For subscription CRM, Acme is the most common choice. HubSpot is also worth a look.\n\nSources: https://acme.test/pricing and https://reddit.com/r/crm";
const NOW = new Date("2026-11-02T10:00:00.000Z");
const base = { brandName: "Acme", brandUrl: "https://acme.test", competitors: ["HubSpot", "Zoho"] };

async function result(engine: string, over: { capturedAt?: Date; cacheLayer?: "l1" | "none"; text?: string } = {}) {
  const parse = await parseScanAnswer({ engineKey: engine, text: over.text ?? ANSWER, ...base });
  return toEngineResult({ engine, parse, capturedAt: over.capturedAt ?? NOW, now: NOW, latencyMs: 120, cacheLayer: over.cacheLayer ?? "none", excerpt: (over.text ?? ANSWER).slice(0, 280) });
}

describe("STORY-079 · scenario 3 - the panel names the engines and there is no picker", () => {
  it("scenario 3 - the request schema has no engine field and refuses one (strict)", () => {
    expect(visibilityScanRequestSchema.safeParse({ brand_name: "Acme", query_text: "best crm" }).success).toBe(true);
    expect(visibilityScanRequestSchema.safeParse({ brand_name: "Acme", query_text: "best crm", engines: ["chatgpt"] }).success).toBe(false);
    expect(Object.keys(visibilityScanRequestSchema.shape)).not.toContain("engines");
  });
});

describe("STORY-079 · scenario 4 - the plan's set never includes an excluded engine", () => {
  it("scenario 4 - claude is never selected, even when entitled and capture-ready", () => {
    const set = selectScanEngines({ size: 4, entitled: ["claude", "gemini", "perplexity"], captureReady: ["claude", "gemini", "perplexity"] });
    expect(set).not.toContain("claude");
    expect(SCAN_EXCLUDED_ENGINES).toContain("claude");
  });
  it("takes at most the plan's tools.engine_set, in a fixed order, from engines that can capture", () => {
    expect(selectScanEngines({ size: 2, entitled: ["perplexity", "chatgpt", "gemini"], captureReady: ["gemini", "chatgpt", "perplexity"] })).toEqual(["perplexity", "chatgpt"]);
    // Only Gemini can capture today: the set is Gemini alone, not a failed attempt on two fixtures.
    expect(selectScanEngines({ size: 2, entitled: ["perplexity", "chatgpt", "gemini"], captureReady: ["gemini"] })).toEqual(["gemini"]);
  });
  it("is empty (not an error) when nothing can capture, and for a zero-sized set", () => {
    expect(selectScanEngines({ size: 4, entitled: ["gemini"], captureReady: [] })).toEqual([]);
    expect(selectScanEngines({ size: 0, entitled: ["gemini"], captureReady: ["gemini"] })).toEqual([]);
  });
  it("an engine the plan is not entitled to is not selected", () => {
    expect(selectScanEngines({ size: 4, entitled: ["perplexity"], captureReady: ["gemini", "perplexity"] })).toEqual(["perplexity"]);
  });
});

describe("STORY-079 · scenario 5 - per-engine events carry all six documented fields", () => {
  it("scenario 5 - presence, position, share of voice, sentiment, citations and an excerpt, valid against the wire schema", async () => {
    const r = await result("perplexity");
    expect(scanStreamEngineResultSchema.safeParse(r).success).toBe(true);
    expect(r.brand_present).toBe(true);
    expect(r.sov).toBeGreaterThan(0);
    expect(r.citations.length).toBeGreaterThan(0);
    expect(r.citations.some((c) => c.is_owned && c.domain === "acme.test")).toBe(true);
    expect(r.excerpt.length).toBeGreaterThan(0);
    expect(r.estimated).toBe(true);
  });
  it("a brand absent from the answer is brand_present false, position null, sentiment absent with a null score (null is not 0)", async () => {
    const r = await result("perplexity", { text: "HubSpot is the most common choice for this." });
    expect(r.brand_present).toBe(false);
    expect(r.rank_position).toBeNull();
    expect(r.sentiment).toEqual({ label: "absent", score: null });
    expect(r.sov).toBe(0);
  });
});

describe("STORY-079 · scenario 9 - a cached engine carries its true capture age", () => {
  it("scenario 9 - captured_at is the answer's time and age_ms is the distance to now, never the run's timestamp", async () => {
    const twoHoursAgo = new Date(NOW.getTime() - 2 * 3_600_000);
    const r = await result("chatgpt", { capturedAt: twoHoursAgo, cacheLayer: "l1" });
    expect(r.cache_layer).toBe("l1");
    expect(r.captured_at).toBe(twoHoursAgo.toISOString());
    expect(r.age_ms).toBe(2 * 3_600_000);
  });
  it("a live capture has age 0 and cache_layer none", async () => {
    const r = await result("chatgpt");
    expect(r.age_ms).toBe(0);
    expect(r.cache_layer).toBe("none");
  });
});

describe("STORY-079 · lexicon-only parse (no arbiter, no network)", () => {
  it("parses without an arbiter and resolves no redirect over the network", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const parse = await parseScanAnswer({ engineKey: "gemini", text: ANSWER, ...base });
      expect(parse.brandPresent).toBe(true);
      expect(parse.mentions.every((m) => m.sentiment.method !== "llm_arbiter")).toBe(true);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("STORY-079 · scenario 10 - the payload states the sample, flags estimates, and carries the not-tracked marker", () => {
  it("scenario 10 - the stored snapshot and terminal event carry the one-sample statement and name what was not checked", async () => {
    const r = await result("perplexity");
    const agg = aggregateScan([r], [], ["perplexity"]);
    expect(agg.estimated_fields).toEqual(expect.arrayContaining(["sov_estimate", "citation_count", "sentiment_label", "brand_present"]));
    const snapshot = visibilityScanResultSchema.parse({
      schema_version: 1,
      sample_statement: "One sample per engine: each figure comes from a single answer at a single moment, so every figure is an estimate.",
      one_sample_per_engine: true,
      engines: [r],
      engine_failures: [],
      competitors: ["HubSpot"],
      deadline_reached: false,
    });
    expect(snapshot.one_sample_per_engine).toBe(true);
    expect(snapshot.engines[0]!.estimated).toBe(true);
  });
  it("a nothing-captured scan has no estimates to flag and null headline figures (null, not 0)", () => {
    const agg = aggregateScan([], [failureFor("perplexity", "timeout")], ["perplexity"]);
    expect(agg).toMatchObject({ sov_estimate: null, citation_count: null, owned_citation_count: null, sentiment_label: null, brand_present: null, estimated_fields: [] });
    expect(agg.engines_failed).toEqual(["perplexity"]);
  });
  it("share of voice averages the engines that answered; citation counts add", async () => {
    const a = await result("perplexity");
    const b = await result("chatgpt", { text: "HubSpot is the most common choice for this." });
    const agg = aggregateScan([a, b], [], ["perplexity", "chatgpt"]);
    expect(agg.sov_estimate).toBeCloseTo((a.sov + b.sov) / 2, 6);
    expect(agg.citation_count).toBe(a.citations.length + b.citations.length);
    expect(agg.brand_present).toBe(true);
  });
});

describe("STORY-079 · failures are named in operator-readable terms", () => {
  it("scenario 8 - a known code reads as a sentence; an unknown one still has a reason", () => {
    expect(failureFor("gemini", "timeout")).toEqual({ engine: "gemini", code: "timeout", reason: expect.stringMatching(/did not answer in time/i) });
    expect(failureFor("gemini", "deadline_exceeded").reason).toMatch(/deadline/i);
    expect(failureFor("gemini", "engine_spend_ceiling_reached").reason).toMatch(/spend/i);
    expect(failureFor("gemini", "something_new").reason.length).toBeGreaterThan(10);
    expect(failureFor("gemini", "timeout").reason).not.toMatch(/error:|stack|at /);
  });
});

function ports(over: Partial<ScanPorts> = {}): { ports: ScanPorts; published: ScanPublished[] } {
  const published: ScanPublished[] = [];
  return {
    published,
    ports: {
      cached: async () => undefined,
      capture: async () => ({ text: ANSWER, latencyMs: 80 }),
      publish: async (event) => {
        published.push(event);
      },
      now: () => NOW,
      ...over,
    },
  };
}
const run = (engines: string[], p: ScanPorts, deadlineMs = 2_000) => runVisibilityScan({ engines, ...base, deadlineMs }, p);

describe("STORY-079 · running the engines", () => {
  it("emits one event per engine as it lands, not at the end", async () => {
    const order: string[] = [];
    const { ports: p, published } = ports({
      capture: async (engine) => {
        await new Promise((r) => setTimeout(r, engine === "slow" ? 60 : 5));
        return { text: ANSWER, latencyMs: 5 };
      },
      publish: async (event) => {
        order.push(event.kind === "engine_result" ? event.result.engine : event.failure.engine);
      },
    });
    void published;
    const outcome = await run(["slow", "fast"], p);
    expect(order).toEqual(["fast", "slow"]);
    expect(outcome.results.map((r) => r.engine).sort()).toEqual(["fast", "slow"]);
    expect(outcome.failures).toEqual([]);
    expect(outcome.deadlineReached).toBe(false);
  });

  it("scenario 6 - all engines failing still resolves, naming each failure; nothing succeeded", async () => {
    const { ports: p, published } = ports({
      capture: async () => {
        throw new ScanCaptureError("timeout");
      },
    });
    const outcome = await run(["perplexity", "chatgpt"], p);
    expect(outcome.results).toEqual([]);
    expect(outcome.failures.map((f) => f.engine).sort()).toEqual(["chatgpt", "perplexity"]);
    expect(published.filter((e) => e.kind === "engine_failed")).toHaveLength(2);
  });

  it("an unexpected error from one engine fails that engine only, with a generic reason that leaks no engine text", async () => {
    const { ports: p } = ports({
      capture: async (engine) => {
        if (engine === "chatgpt") throw new Error("vendor said: SECRET-RAW-BODY");
        return { text: ANSWER, latencyMs: 5 };
      },
    });
    const outcome = await run(["perplexity", "chatgpt"], p);
    expect(outcome.results.map((r) => r.engine)).toEqual(["perplexity"]);
    expect(outcome.failures[0]).toMatchObject({ engine: "chatgpt", code: "engine_error" });
    expect(JSON.stringify(outcome.failures)).not.toContain("SECRET-RAW-BODY");
  });

  it("scenario 8 - an engine past the deadline is a named failure; what landed is returned, not nothing", async () => {
    const { ports: p } = ports({
      capture: async (engine) => {
        if (engine === "stuck") await new Promise((r) => setTimeout(r, 400));
        return { text: ANSWER, latencyMs: 5 };
      },
    });
    const started = Date.now();
    const outcome = await run(["fast", "stuck"], p, 80);
    expect(Date.now() - started).toBeLessThan(300);
    expect(outcome.deadlineReached).toBe(true);
    expect(outcome.results.map((r) => r.engine)).toEqual(["fast"]);
    expect(outcome.failures).toEqual([expect.objectContaining({ engine: "stuck", code: "deadline_exceeded" })]);
  });

  it("scenario 9 - a cached answer is served without a capture, labelled with its own capture time", async () => {
    const twoHoursAgo = new Date(NOW.getTime() - 2 * 3_600_000);
    const capture = vi.fn(async () => ({ text: ANSWER, latencyMs: 5 }));
    const { ports: p } = ports({ cached: async (engine) => (engine === "chatgpt" ? { text: ANSWER, capturedAt: twoHoursAgo } : undefined), capture });
    const outcome = await run(["chatgpt", "perplexity"], p);
    const cached = outcome.results.find((r) => r.engine === "chatgpt")!;
    expect(cached.cache_layer).toBe("l1");
    expect(cached.captured_at).toBe(twoHoursAgo.toISOString());
    expect(cached.age_ms).toBe(2 * 3_600_000);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith("perplexity");
  });

  it("a cache read that fails falls through to a live capture rather than failing the engine", async () => {
    const { ports: p } = ports({
      cached: async () => {
        throw new Error("cache down");
      },
    });
    const outcome = await run(["perplexity"], p);
    expect(outcome.results).toHaveLength(1);
    expect(outcome.results[0]!.cache_layer).toBe("none");
  });

  it("detected competitors are the hinted names the answers actually mentioned", async () => {
    const outcome = await run(["perplexity"], ports().ports);
    expect(outcome.competitors).toEqual(["HubSpot"]);
  });

  it("an empty engine list resolves to an empty outcome (the caller refuses such a scan before charging)", async () => {
    const outcome = await run([], ports().ports);
    expect(outcome).toMatchObject({ results: [], failures: [], deadlineReached: false });
  });

  it("the terminal wire shape validates for a failed run", () => {
    const parsed = scanStreamCompletedSchema.safeParse({
      tool_run_id: "0197d3a0-0000-7000-8000-000000000001",
      status: "failed",
      duration_ms: 1200,
      aggregate: aggregateScan([], [failureFor("gemini", "timeout")], ["gemini"]),
      engine_failures: [failureFor("gemini", "timeout")],
      credits: { charged: 0, refunded: 10 },
      deadline_reached: false,
      not_tracked: true,
      did_not_check: "x",
      sample_statement: "y",
      convert_cta: null,
    });
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });
});
