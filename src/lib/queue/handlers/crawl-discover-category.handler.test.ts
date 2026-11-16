import { trace } from "@opentelemetry/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";
import type { ClientBase } from "pg";
import { createCrawlDiscoverHandler } from "./crawl-discover.handler.js";
import type { QueueHandlerContext } from "../handlers.js";
import type { DiscoverDeps } from "../../discovery/discover.js";
import { classifyCategory, type TextEmbedder } from "../../categories/classify.js";
import { phasesOf } from "../worker-factory.js";
import { incrementCounter } from "../../telemetry/metrics.js";
import { CategoryEmbedBudget, InMemoryTokenCounterStore, estimateTokens, type TokenCounterStore } from "../../categories/embed-budget.js";
import { emailAlert } from "../../alerts/alerts.js";

vi.mock("../../telemetry/metrics.js", () => ({ observeValue: vi.fn(), incrementCounter: vi.fn() }));
vi.mock("../../alerts/alerts.js", () => ({ emailAlert: vi.fn() }));
vi.mock("../../categories/classify.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../categories/classify.js")>();
  return { ...original, classifyCategory: vi.fn(original.classifyCategory) };
});

// STORY-189 AC3-AC5 at the handler: the taxonomy is read in `prepare`, the classification happens in `run` (no transaction held across the
// embedding call, ADR-0003), and the curated peers are merged in `commit` after the site's own comparison links.

const PROJECT = "0f9e2a7c-1b3d-4e5f-8a9b-0c1d2e3f4a5b";
const WORKSPACE = "11111111-1111-7111-8111-111111111111";
const CONTEXT = { pool: {} as never, env: {} as never } satisfies QueueHandlerContext;

const job = (payload: Record<string, unknown> = {}): Job =>
  ({ data: { payload: { workspaceId: WORKSPACE, kid: "k1", projectId: PROJECT, rootUrl: "https://hubspot.com", fieldsSupplied: [], ...payload } } }) as unknown as Job;

const TAXONOMY = [
  { slug: "crm", name: "CRM", description: "contacts and deals" },
  { slug: "banks", name: "Banks", description: "checking and savings" },
];

const PAGE = `<html lang="en-US"><head><title>HubSpot CRM</title>
  <meta name="description" content="contacts and deals for sales teams">
  </head><body><a href="/compare/hubspot-vs-salesforce">HubSpot vs Salesforce</a></body></html>`;

function embedderPicking(slug: "crm" | "banks" | "flat"): TextEmbedder & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    model: `handler-model-${slug}-${String(Math.random())}`,
    calls,
    embed: vi.fn(async (texts: readonly string[]) => {
      calls.push([...texts]);
      return {
        vectors: texts.map((t) => {
          if (t.startsWith("CRM.")) return [1, 0];
          if (t.startsWith("Banks.")) return [0, 1];
          return slug === "crm" ? [1, 0.05] : slug === "banks" ? [0.05, 1] : [1, 1];
        }),
        totalTokens: texts.length,
      };
    }),
  };
}

function txFor(calls: { sql: string; params: unknown[] }[], opts: { project?: Record<string, unknown>; taxonomy?: unknown[]; peers?: unknown[] } = {}) {
  return {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes("SELECT root_domain")) return { rows: [{ root_domain: "hubspot.com", discovery: {}, ...opts.project }] };
      if (sql.includes("FROM business_categories")) return { rows: opts.taxonomy ?? TAXONOMY };
      if (sql.includes("FROM category_peers")) return { rows: opts.peers ?? [] };
      if (sql.includes("FROM projects") && sql.includes("FOR NO KEY UPDATE")) return { rows: [{ name: "HubSpot", root_domain: "hubspot.com", category_slug: "crm", verticals: ["saas"], locale: null }] };
      if (sql.includes("generation_source = 'generated'")) return { rows: [] };
      return { rows: [] };
    }),
  } as unknown as ClientBase;
}

function serving(html: string): DiscoverDeps {
  return { fetch: vi.fn(async () => ({ status: 200, headers: {}, body: Buffer.from(html), finalUrl: "https://hubspot.com/" })), now: () => Date.now() };
}

interface Payload {
  fields: Record<string, { value: unknown; confidence: number; source: string; user_edited: boolean }>;
  low_confidence_fields: string[];
  competitors_proposed: { name: string; root_domain?: string; confidence: number; basis: string }[];
}
const storedPayload = (calls: { sql: string; params: unknown[] }[]): Payload => JSON.parse(calls.find((c) => c.sql.includes("SET discovery = $2"))!.params[1] as string) as Payload;

const PEERS = [
  { name: "Pipedrive", root_domain: "pipedrive.com" },
  { name: "Zoho", root_domain: "zoho.com" },
  { name: "HubSpot", root_domain: "hubspot.com" },
  { name: "Freshsales", root_domain: "freshworks.com" },
  { name: "Insightly", root_domain: "insightly.com" },
  { name: "Copper", root_domain: "copper.com" },
];

describe("STORY-189 · crawl.discover classifies and proposes peers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(incrementCounter).mockClear();
  });

  it("AC3 — the stored review payload carries the category with a value, confidence, source and edited flag", async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    await createCrawlDiscoverHandler(CONTEXT, serving(PAGE), embedderPicking("crm"))(txFor(calls), job());
    expect(storedPayload(calls).fields.category).toMatchObject({ value: "crm", source: "embedding nearest match", user_edited: false });
    expect(storedPayload(calls).fields.category!.confidence).toBeGreaterThanOrEqual(0.6);
  });

  it("AC3 — discovery writes NOTHING to projects.category_slug: a discovered value is applied only by the confirm step", async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    await createCrawlDiscoverHandler(CONTEXT, serving(PAGE), embedderPicking("crm"))(txFor(calls), job());
    expect(calls.some((c) => /category_slug\s*=/.test(c.sql) && c.sql.includes("UPDATE projects"))).toBe(false);
  });

  it("AC4 — a category the classifier is unsure of is listed in low_confidence_fields", async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    await createCrawlDiscoverHandler(CONTEXT, serving(PAGE), embedderPicking("flat"))(txFor(calls), job());
    expect(storedPayload(calls).low_confidence_fields).toContain("category");
  });

  it("AC4 — a caller-supplied category is never re-proposed, and no embedding call is made for it", async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    const embedder = embedderPicking("banks");
    await createCrawlDiscoverHandler(CONTEXT, serving(PAGE), embedder)(txFor(calls, { project: { category_slug: "banks" } }), job({ fieldsSupplied: ["category_slug"] }));
    expect(embedder.calls).toEqual([]);
    expect(storedPayload(calls).fields.category).toBeUndefined();
  });

  it("AC7 / ADR-0003 — the embedding call is made in `run`, with no transaction in use: prepare's client is untouched while it runs", async () => {
    const events: string[] = [];
    const embedder = embedderPicking("crm");
    const inner = embedder.embed;
    (embedder as { embed: TextEmbedder["embed"] }).embed = async (texts) => {
      events.push("embed");
      return inner(texts);
    };
    const prepareCalls: { sql: string; params: unknown[] }[] = [];
    const prepareTx = txFor(prepareCalls);
    const original = prepareTx.query as unknown as (sql: string, params?: unknown[]) => Promise<unknown>;
    (prepareTx as unknown as { query: unknown }).query = async (sql: string, params?: unknown[]) => {
      events.push("tx");
      return original(sql, params);
    };
    const phases = phasesOf(createCrawlDiscoverHandler(CONTEXT, serving(PAGE), embedder))!;
    const prepared = await phases.prepare(prepareTx, job());
    const fetched = await phases.run(prepared as never, job());
    await phases.commit(txFor([]), prepared as never, fetched, job());
    expect(events).toContain("embed");
    expect(events.indexOf("embed")).toBeGreaterThan(events.lastIndexOf("tx"));
    // The taxonomy was read in prepare, not in run.
    expect(prepareCalls.some((c) => c.sql.includes("FROM business_categories"))).toBe(true);
  });

  it("a provider failure leaves the pass completed, proposes no category and still finishes the job", async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    const broken: TextEmbedder = {
      model: "broken-handler-model",
      embed: async () => {
        throw new Error("provider down");
      },
    };
    await createCrawlDiscoverHandler(CONTEXT, serving(PAGE), broken)(txFor(calls), job());
    const payload = storedPayload(calls);
    expect(payload.fields.category).toBeUndefined();
    expect(payload.fields.description).toBeDefined();
    expect(vi.mocked(incrementCounter)).toHaveBeenCalledWith("nominara_discovery_category_total", { outcome: "failed" });
  });

  it("an empty taxonomy proposes no category and makes no provider call", async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    const embedder = embedderPicking("crm");
    await createCrawlDiscoverHandler(CONTEXT, serving(PAGE), embedder)(txFor(calls, { taxonomy: [] }), job());
    expect(embedder.calls).toEqual([]);
    expect(storedPayload(calls).fields.category).toBeUndefined();
  });

  describe("AC5 — category peers", () => {
    it("are proposed with the basis 'category peer' and confidence 1.0, AFTER the site's own comparison links, within five, without the project's own domain", async () => {
      const calls: { sql: string; params: unknown[] }[] = [];
      await createCrawlDiscoverHandler(CONTEXT, serving(PAGE), embedderPicking("crm"))(txFor(calls, { peers: PEERS }), job());
      const { competitors_proposed: list } = storedPayload(calls);
      expect(list.map((c) => c.name)).toEqual(["Salesforce", "Pipedrive", "Zoho", "Freshsales", "Insightly"]);
      expect(list[0]!.basis).toBe("own comparison page");
      for (const peer of list.slice(1)) expect(peer).toMatchObject({ basis: "category peer", confidence: 1 });
      expect(list.some((c) => c.root_domain === "hubspot.com")).toBe(false);
    });

    it("are read for the discovered category only when it is confident; a low-confidence category brings no peers", async () => {
      const calls: { sql: string; params: unknown[] }[] = [];
      await createCrawlDiscoverHandler(CONTEXT, serving(PAGE), embedderPicking("flat"))(txFor(calls, { peers: PEERS }), job());
      expect(storedPayload(calls).competitors_proposed.map((c) => c.basis)).toEqual(["own comparison page"]);
      expect(calls.some((c) => c.sql.includes("FROM category_peers"))).toBe(false);
    });

    it("use the category the project already holds when the caller supplied one", async () => {
      const calls: { sql: string; params: unknown[] }[] = [];
      await createCrawlDiscoverHandler(CONTEXT, serving(PAGE), embedderPicking("banks"))(txFor(calls, { project: { category_slug: "crm" }, peers: PEERS }), job({ fieldsSupplied: ["category_slug"] }));
      const read = calls.find((c) => c.sql.includes("FROM category_peers"))!;
      expect(read.params).toEqual(["crm"]);
      expect(storedPayload(calls).competitors_proposed.some((c) => c.basis === "category peer")).toBe(true);
    });

    it("are not proposed when the caller supplied competitors (supplied wins)", async () => {
      const calls: { sql: string; params: unknown[] }[] = [];
      await createCrawlDiscoverHandler(CONTEXT, serving(PAGE), embedderPicking("crm"))(txFor(calls, { peers: PEERS }), job({ fieldsSupplied: ["competitors"] }));
      expect(storedPayload(calls).competitors_proposed.some((c) => c.basis === "category peer")).toBe(false);
    });

    it("the peer read names the category slug as a parameter, and never reads other customers' projects", async () => {
      const calls: { sql: string; params: unknown[] }[] = [];
      await createCrawlDiscoverHandler(CONTEXT, serving(PAGE), embedderPicking("crm"))(txFor(calls, { peers: PEERS }), job());
      const read = calls.find((c) => c.sql.includes("FROM category_peers"))!;
      expect(read.params).toEqual(["crm"]);
      expect(read.sql).not.toMatch(/\bprojects\b|\bcompetitors\b/);
    });
  });

  describe("observability", () => {
    it("counts the outcome, opens a span, and logs the workspace id with no category text", async () => {
      const spans: string[] = [];
      vi.spyOn(trace, "getTracer").mockReturnValue({
        startActiveSpan: (name: string, fn: (span: unknown) => unknown) => {
          spans.push(name);
          return fn({ setAttribute: vi.fn(), setStatus: vi.fn(), end: vi.fn(), recordException: vi.fn() });
        },
      } as never);
      const { Logger } = await import("@nestjs/common");
      const lines: string[] = [];
      vi.spyOn(Logger.prototype, "log").mockImplementation((m: unknown) => void lines.push(typeof m === "string" ? m : JSON.stringify(m)));
      const calls: { sql: string; params: unknown[] }[] = [];
      await createCrawlDiscoverHandler(CONTEXT, serving(PAGE), embedderPicking("crm"))(txFor(calls, { peers: PEERS }), job());

      expect(spans).toContain("discovery.classify_category");
      expect(vi.mocked(incrementCounter)).toHaveBeenCalledWith("nominara_discovery_category_total", { outcome: "proposed" });
      const line = lines.find((l) => l.includes(WORKSPACE) && /category/.test(l))!;
      expect(line).toBeDefined();
      expect(line).not.toMatch(/hubspot|pipedrive|salesforce|contacts and deals/i);
    });

    it("STORY-190 - logs the comparison-page counts with the workspace id and never a URL or a competitor name", async () => {
      const { Logger } = await import("@nestjs/common");
      const lines: string[] = [];
      vi.spyOn(Logger.prototype, "log").mockImplementation((m: unknown) => void lines.push(typeof m === "string" ? m : JSON.stringify(m)));
      const home = `<html><body><a href="/compare">Compare</a></body></html>`;
      const fetched: string[] = [];
      const deps: DiscoverDeps = {
        fetch: (async (url: string) => {
          fetched.push(url);
          const body = url.endsWith("/compare") ? "<h1>HubSpot vs Salesforce</h1>" : home;
          return { status: 200, headers: {}, body: Buffer.from(body), finalUrl: url };
        }) as never,
        now: () => Date.now(),
      };
      await createCrawlDiscoverHandler(CONTEXT, deps)(txFor([]), job());
      const line = lines.find((l) => l.includes("comparison pages"))!;
      expect(line).toContain(WORKSPACE);
      expect(line).toMatch(/1 selected, 1 read/);
      expect(line).not.toMatch(/salesforce|\/compare/i);
    });
  });

  describe("AC7 / decision 107(b) — token budget", () => {
    const store = () => new InMemoryTokenCounterStore();

    it("AC7 — over the daily ceiling: not classified, no provider call, outcome names the reason, and the owner is alerted", async () => {
      const emailAlertMock = vi.mocked(emailAlert);
      emailAlertMock.mockClear();
      const calls: { sql: string; params: unknown[] }[] = [];
      const embedder = embedderPicking("crm");
      const budget = new CategoryEmbedBudget({ store: store(), dailyCeiling: 1, maxInputTokens: 2000 });
      await createCrawlDiscoverHandler(CONTEXT, serving(PAGE), embedder, budget)(txFor(calls), job());
      expect(embedder.calls).toEqual([]);
      expect(storedPayload(calls).fields.category).toBeUndefined();
      expect(vi.mocked(incrementCounter)).toHaveBeenCalledWith("nominara_discovery_category_total", { outcome: "budget_exhausted" });
      expect(emailAlertMock).toHaveBeenCalledTimes(1);
      expect(emailAlertMock.mock.calls[0]![1]).toMatchObject({ alertName: "category_embed_daily_ceiling", reason: "daily_ceiling" });
    });

    it("AC7 — the pass still completes (other fields discovered), and nothing is charged to the workspace", async () => {
      const calls: { sql: string; params: unknown[] }[] = [];
      const budget = new CategoryEmbedBudget({ store: store(), dailyCeiling: 1, maxInputTokens: 2000 });
      await createCrawlDiscoverHandler(CONTEXT, serving(PAGE), embedderPicking("crm"), budget)(txFor(calls), job());
      expect(storedPayload(calls).fields.description).toBeDefined();
      expect(calls.some((c) => /credit_ledger|credit_wallets|reserve_credits|debit/i.test(c.sql))).toBe(false);
    });

    it("AC7 — under the ceiling the site text sent to the provider is within the per-project cap", async () => {
      const embedder = embedderPicking("crm");
      const budget = new CategoryEmbedBudget({ store: store(), dailyCeiling: 1_000_000, maxInputTokens: 10 });
      await createCrawlDiscoverHandler(CONTEXT, serving(PAGE), embedder, budget)(txFor([]), job());
      const siteCall = embedder.calls.find((c) => c.length === 1 && !c[0]!.startsWith("CRM.") && !c[0]!.startsWith("Banks."))!;
      expect(estimateTokens(siteCall[0]!)).toBeLessThanOrEqual(10);
    });

    it("AC7 / ADR-0003 — the budget check and the embedding both happen with no transaction in use", async () => {
      const events: string[] = [];
      const counting: TokenCounterStore = {
        addAndGet: async (key, delta, ttl) => {
          events.push("budget");
          return store().addAndGet(key, delta, ttl);
        },
      };
      const budget = new CategoryEmbedBudget({ store: counting });
      const prepareTx = txFor([]);
      const original = prepareTx.query as unknown as (sql: string, params?: unknown[]) => Promise<unknown>;
      (prepareTx as unknown as { query: unknown }).query = async (sql: string, params?: unknown[]) => {
        events.push("tx");
        return original(sql, params);
      };
      const phases = phasesOf(createCrawlDiscoverHandler(CONTEXT, serving(PAGE), embedderPicking("crm"), budget))!;
      const prepared = await phases.prepare(prepareTx, job());
      const fetched = await phases.run(prepared as never, job());
      await phases.commit(txFor([]), prepared as never, fetched, job());
      expect(events).toContain("budget");
      expect(events.indexOf("budget")).toBeGreaterThan(events.lastIndexOf("tx"));
    });

    it("AC7 — a null classification after the provider was paid still leaves the spend on the counter (not refunded)", async () => {
      const counter = store();
      const budget = new CategoryEmbedBudget({ store: counter, dailyCeiling: 1_000_000, maxInputTokens: 2000 });
      vi.mocked(classifyCategory).mockImplementationOnce(async (_text, _cats, _embedder, spend) => {
        if (spend) spend.tokens += 500; // paid for, then no match
        return null;
      });
      await createCrawlDiscoverHandler(CONTEXT, serving(PAGE), embedderPicking("crm"), budget)(txFor([]), job());
      expect(await counter.addAndGet(budget.dayKey(), 0, 1)).toBeGreaterThanOrEqual(500);
    });

    it("AC7 — an unreadable counter is a distinct outcome and never reads as a provider failure", async () => {
      const down: TokenCounterStore = { addAndGet: async () => { throw new Error("down"); } };
      await createCrawlDiscoverHandler(CONTEXT, serving(PAGE), embedderPicking("crm"), new CategoryEmbedBudget({ store: down }))(txFor([]), job());
      expect(vi.mocked(incrementCounter)).toHaveBeenCalledWith("nominara_discovery_category_total", { outcome: "budget_unavailable" });
    });
  });
});
