import { readFileSync } from "node:fs";
import type { Job } from "bullmq";
import { describe, expect, it } from "vitest";
import type { CaptureAdapter, RawCapture } from "../../engines/contract.js";
import type { CaptureEngineGate } from "../../engines/capture-engine-gate.js";
import type { SpendMeter } from "../../engines/spend-meter.js";
import { GuardedFetchRefusal, type GuardedResponse } from "../../net/guarded-fetch.js";
import type { QueueHandlerContext } from "../handlers.js";
import { createCompetitorFindPhases } from "./competitor-find.handler.js";

// STORY-081 - the worker half, run phase only (no database): the fetch path, the guard, the span-built rows. Scenario numbers are the story's table.

const HTML = `<html><head><title>Acme Invoicing | Invoices</title><meta name="description" content="Acme Invoicing sends invoices and chases late payments for freelancers."></head></html>`;
const PROSE_ONLY = "1. **Billwise** — invoices.\n2. **LedgerLark**: bookkeeping.\n\nSalesforce is also widely used in this market.";
const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const RUN = "22222222-2222-4222-8222-222222222222";

const page = (body: string, over: Partial<GuardedResponse> = {}): GuardedResponse => ({ status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body: Buffer.from(body), finalUrl: "https://acme-invoicing.example/", ...over });
const raw = (text: string): RawCapture => ({ text, format: "markdown", truncated: false, responseTokensEst: 20, latencyMs: 30, costUsd: 0 });
const adapter = (text: string, calls: { n: number; prompt: string }): CaptureAdapter =>
  ({
    engineKey: "gemini",
    captureMode: "api",
    adapterVersion: "1.0.0",
    supportsCitations: true,
    concurrencyPerTask: 1,
    capture: async (request: { promptText: string }) => {
      calls.n += 1;
      calls.prompt = request.promptText;
      return raw(text);
    },
    healthProbe: async () => ({ ok: true, latencyMs: 1 }),
  }) as unknown as CaptureAdapter;

function harness(opts: { answer?: string; fetchPage?: (url: string) => Promise<GuardedResponse> }) {
  const calls = { n: 0, prompt: "" };
  const fetched: string[] = [];
  const fetchPage = opts.fetchPage ?? (async (url: string) => (url.endsWith("/robots.txt") ? page("User-agent: *\nAllow: /", { headers: { "content-type": "text/plain" } }) : page(HTML)));
  const phases = createCompetitorFindPhases({ pool: {}, env: {} } as unknown as QueueHandlerContext, {
    cache: {} as never,
    spendMeter: { isCeilingReached: async () => false } as unknown as SpendMeter,
    engineGate: { admit: async () => ({ kind: "admit" }), record: async () => undefined } as unknown as CaptureEngineGate,
    resolveAdapter: () => adapter(opts.answer ?? PROSE_ONLY, calls),
    fetchPage: async (url, init) => {
      fetched.push(url);
      expect(init.headers?.["user-agent"]).toContain("NominaraBot");
      return await fetchPage(url);
    },
  });
  const payload = { tool: "competitor_finder" as const, toolRunId: RUN, targetUrl: "https://acme-invoicing.example/", engine: "gemini", locale: "en-US", startedAt: "2026-11-06T10:00:00.000Z", workspaceId: WORKSPACE };
  const run = async () => await phases.run({ payload }, {} as Job);
  return { run, calls, fetched };
}

describe("STORY-081 · the Competitor Finder worker", () => {
  it("scenario 1 - derives the query from the fetched page and makes exactly one capture", async () => {
    const h = harness({});
    const out = await h.run();
    expect(out.failureCode).toBeNull();
    expect(h.calls.n).toBe(1);
    expect(h.calls.prompt.toLowerCase()).toContain("invoices");
    expect(out.result!.scope.query).toBe(h.calls.prompt);
  });

  it("scenario 2 - an internal address is refused by the existing forgery guard: no capture, named failure", async () => {
    const h = harness({ fetchPage: async () => { throw new GuardedFetchRefusal("address_not_global"); } });
    const out = await h.run();
    expect(out.failureCode).toBe("unsafe_target");
    expect(out.result).toBeNull();
    expect(h.calls.n).toBe(0);
  });

  it("scenario 3 - the fetch goes through the existing guarded fetcher: robots first, then the page, and no second path in the source", () => {
    const source = readFileSync(new URL("./competitor-find.handler.ts", import.meta.url), "utf8");
    expect(source).toMatch(/from "\.\.\/\.\.\/net\/guarded-fetch\.js"/u);
    expect(source).not.toMatch(/node:https?|undici|\bfetch\(|axios|got\(/u);
    expect(source).toMatch(/from "\.\.\/\.\.\/aux\/robots\.js"/u);
  });

  it("scenario 3 - robots.txt is requested before the page, with the identified user agent", async () => {
    const h = harness({});
    await h.run();
    expect(h.fetched[0]).toMatch(/\/robots\.txt$/u);
    expect(h.fetched[1]).toBe("https://acme-invoicing.example/");
  });

  it("a page robots.txt disallows is not fetched and nothing is captured", async () => {
    const h = harness({ fetchPage: async (url) => (url.endsWith("/robots.txt") ? page("User-agent: NominaraBot\nDisallow: /", { headers: { "content-type": "text/plain" } }) : page(HTML)) });
    const out = await h.run();
    expect(out.failureCode).toBe("robots_disallowed");
    expect(h.fetched).toEqual(["https://acme-invoicing.example/robots.txt"]);
    expect(h.calls.n).toBe(0);
  });

  it("a page with no usable category derives no query and captures nothing", async () => {
    const h = harness({ fetchPage: async (url) => (url.endsWith("/robots.txt") ? page("", { status: 404 }) : page("<html><body></body></html>")) });
    const out = await h.run();
    expect(out.failureCode).toBe("no_category_found");
    expect(h.calls.n).toBe(0);
  });

  it("scenario 4 and 5 - rows come from spans with their excerpt, and the unspanned prose name is absent", async () => {
    const out = await harness({}).run();
    expect(out.result!.entities.map((e) => e.name)).toEqual(["Billwise", "LedgerLark"]);
    expect(out.result!.entities.every((e) => e.excerpt.includes(e.name))).toBe(true);
    expect(JSON.stringify(out.result)).not.toContain("Salesforce");
  });

  it("scenario 9 - an answer that names nothing stores an empty result (the commit refunds it)", async () => {
    const out = await harness({ answer: "I could not name specific companies for this category." }).run();
    expect(out.failureCode).toBeNull();
    expect(out.result!.entities).toEqual([]);
    expect(out.result!.competitors).toEqual([]);
  });

  it("the page's own brand is not reported as its own competitor", async () => {
    const out = await harness({ answer: "1. **Acme** — that is the page itself.\n2. **Billwise** — other." }).run();
    expect(out.result!.entities.map((e) => e.name)).toEqual(["Billwise"]);
  });
});
