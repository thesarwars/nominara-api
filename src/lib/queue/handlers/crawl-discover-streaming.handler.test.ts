import { afterEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";
import type { ClientBase } from "pg";
import { createCrawlDiscoverHandler } from "./crawl-discover.handler.js";
import type { QueueHandlerContext } from "../handlers.js";
import type { DiscoverDeps } from "../../discovery/discover.js";
import { phasesOf } from "../worker-factory.js";
import { incrementCounter } from "../../telemetry/metrics.js";

vi.mock("../../telemetry/metrics.js", () => ({ observeValue: vi.fn(), incrementCounter: vi.fn() }));

// STORY-195 AC6 - the crawl.discover handler writes each field as it is found, in its OWN short tenant transaction (ADR-0003): the run phase
// holds no transaction, so a checkpoint is handed a `step` that opens one for the write alone.

const PROJECT = "0f9e2a7c-1b3d-4e5f-8a9b-0c1d2e3f4a5b";
const WORKSPACE = "11111111-1111-7111-8111-111111111111";
const CONTEXT = { pool: {} as never, env: {} as never } satisfies QueueHandlerContext;
const PAGE = `<html lang="en-US"><head><script type="application/ld+json">{"@type":"Organization","name":"HubSpot"}</script></head></html>`;

const job = (): Job => ({ data: { payload: { workspaceId: WORKSPACE, kid: "k1", projectId: PROJECT, rootUrl: "https://hubspot.com", fieldsSupplied: [] } } }) as unknown as Job;
const deps = (): DiscoverDeps => ({ fetch: vi.fn(async () => ({ status: 200, headers: {}, body: Buffer.from(PAGE), finalUrl: "https://hubspot.com/" })), now: () => Date.now() });

interface Call { sql: string; params: unknown[] }
function tx(calls: Call[], row: Record<string, unknown> = { root_domain: "hubspot.com", discovery: {} }): ClientBase {
  return {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return { rows: sql.includes("SELECT root_domain") ? [row] : [], rowCount: 1 };
    }),
  } as unknown as ClientBase;
}

afterEach(() => vi.clearAllMocks());

describe("STORY-195 · crawl.discover checkpoints the fields it has found", () => {
  it("STORY-195-AC6 the run phase hands each snapshot to the step, which writes it with the status still 'running'", async () => {
    const phases = phasesOf(createCrawlDiscoverHandler(CONTEXT, deps()))!;
    const prepared = await phases.prepare(tx([]), job());
    const writes: Call[] = [];
    const step = vi.fn(async (fn: (t: ClientBase) => Promise<void>) => fn(tx(writes)));

    await (phases.run as (p: unknown, j: Job, s: unknown) => Promise<unknown>)(prepared, job(), step);

    expect(step).toHaveBeenCalled();
    const write = writes.find((c) => c.sql.includes("UPDATE projects"))!;
    expect(write.params[0]).toBe(PROJECT);
    const payload = JSON.parse(write.params[1] as string) as { discovery_status: string; fields: Record<string, { confidence: number; source: string }> };
    expect(payload.discovery_status).toBe("running");
    expect(payload.fields.brand_name?.confidence).toBeGreaterThan(0);
    expect(payload.fields.brand_name?.source).toBeTruthy();
  });

  it("STORY-195-AC6 a checkpoint never overwrites a finished payload: it is guarded on the project still being pending or running", async () => {
    const phases = phasesOf(createCrawlDiscoverHandler(CONTEXT, deps()))!;
    const prepared = await phases.prepare(tx([]), job());
    const writes: Call[] = [];
    await (phases.run as (p: unknown, j: Job, s: unknown) => Promise<unknown>)(prepared, job(), async (fn: (t: ClientBase) => Promise<void>) => fn(tx(writes)));
    expect(writes.find((c) => c.sql.includes("UPDATE projects"))!.sql).toMatch(/discovery_status IN \('pending', 'running'\)/);
    expect(writes.find((c) => c.sql.includes("UPDATE projects"))!.sql).toMatch(/deleted_at IS NULL/);
  });

  it("STORY-195-AC6 a checkpoint keeps the human-decided fields and the earlier payload's other parts", async () => {
    const stored = {
      discovery_status: "completed", duration_ms: 5, competitors_proposed: [{ name: "Rival", root_domain: "rival.com", basis: "own comparison page", confidence: 0.8 }],
      prompts_generated: [], prompts_free_remaining: 3, credits_charged: 0, low_confidence_fields: [],
      fields: { description: { value: "Mine", confidence: 1, source: "user", user_edited: true } },
    };
    const phases = phasesOf(createCrawlDiscoverHandler(CONTEXT, deps()))!;
    const prepared = await phases.prepare(tx([], { root_domain: "hubspot.com", discovery: stored }), job());
    const writes: Call[] = [];
    await (phases.run as (p: unknown, j: Job, s: unknown) => Promise<unknown>)(prepared, job(), async (fn: (t: ClientBase) => Promise<void>) => fn(tx(writes)));
    const payload = JSON.parse(writes.find((c) => c.sql.includes("UPDATE projects"))!.params[1] as string) as typeof stored & { fields: Record<string, { value: unknown }> };
    expect(payload.fields.description?.value).toBe("Mine");
    expect(payload.competitors_proposed).toHaveLength(1);
    expect(payload.discovery_status).toBe("running");
  });

  it("STORY-195-AC6 a checkpoint that fails is counted and logged-free of text, and the pass still completes with the same result", async () => {
    const phases = phasesOf(createCrawlDiscoverHandler(CONTEXT, deps()))!;
    const prepared = await phases.prepare(tx([]), job());
    const baseline = await phases.run(prepared as never, job());
    const result = await (phases.run as (p: unknown, j: Job, s: unknown) => Promise<unknown>)(prepared, job(), async () => {
      throw new Error("db down");
    });
    expect({ ...(result as object), duration_ms: 0 }).toEqual({ ...(baseline as object), duration_ms: 0 });
    expect(incrementCounter).toHaveBeenCalledWith("nominara_discovery_checkpoint_failed_total", {});
  });

  it("STORY-195-AC6 without a step (a direct caller) nothing is checkpointed and the result is unchanged", async () => {
    const phases = phasesOf(createCrawlDiscoverHandler(CONTEXT, deps()))!;
    const prepared = await phases.prepare(tx([]), job());
    await expect(phases.run(prepared as never, job())).resolves.toMatchObject({ discovery_status: "completed" });
  });

  it("STORY-195-AC6 composed on ONE client (a plain call), the checkpoint runs on that client", async () => {
    const calls: Call[] = [];
    const handler = createCrawlDiscoverHandler(CONTEXT, deps());
    await handler(tx(calls), job());
    const running = calls.filter((c) => /discovery_status IN \('pending', 'running'\)/.test(c.sql) && c.sql.includes("discovery = $2"));
    expect(running.length).toBeGreaterThanOrEqual(1);
  });
});

describe("STORY-043 AC15 · crawl.discover feeds the latency judge from submission", () => {
  it("STORY-043-AC15 the commit observes the time since the project was created, in milliseconds, queue wait included", async () => {
    const { defaultDiscoveryLatencyMonitor } = await import("../../discovery/latency-alert.js");
    const observe = vi.spyOn(defaultDiscoveryLatencyMonitor, "observe").mockImplementation(() => undefined);
    const submitted = new Date(1_000_000);
    const handler = createCrawlDiscoverHandler(CONTEXT, { ...deps(), now: () => 1_000_000 + 12_345 });
    await handler(tx([], { root_domain: "hubspot.com", discovery: {}, created_at: submitted }), job());
    expect(observe).toHaveBeenCalledWith(12_345);
    observe.mockRestore();
  });

  it("STORY-043-AC15 a project with no submission time is no observation (0 would read as an instant pass)", async () => {
    const { defaultDiscoveryLatencyMonitor } = await import("../../discovery/latency-alert.js");
    const observe = vi.spyOn(defaultDiscoveryLatencyMonitor, "observe").mockImplementation(() => undefined);
    await createCrawlDiscoverHandler(CONTEXT, deps())(tx([], { root_domain: "hubspot.com", discovery: {} }), job());
    expect(observe).not.toHaveBeenCalled();
    observe.mockRestore();
  });
});

// A fake projects row: the discovery payload is mutable state, so a confirm can land between two writes of the pass.
function liveRow(initial: unknown = {}) {
  const state = { discovery: initial as Record<string, unknown>, status: "pending" };
  const client = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes("SELECT root_domain")) return { rows: [{ root_domain: "hubspot.com", discovery: state.discovery }], rowCount: 1 };
      if (/SELECT discovery/.test(sql) && sql.includes("FOR UPDATE")) return { rows: [{ discovery: state.discovery, category_slug: null }], rowCount: 1 };
      if (sql.includes("discovery = $2")) {
        state.discovery = JSON.parse(params[1] as string) as Record<string, unknown>;
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("jsonb_set")) {
        state.discovery = { ...state.discovery, discovery_status: "partial" };
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    }),
  } as unknown as ClientBase;
  return { state, client };
}
const MINE = { value: "Mine", confidence: 1, source: "user", user_edited: true };
type Fields = Record<string, { value: unknown; user_edited?: boolean }>;

describe("STORY-044 AC4 / STORY-195 · a confirm made mid-pass survives the pass", () => {
  it("STORY-044-AC4 an override landing between two checkpoints is neither overwritten by the next checkpoint nor by the commit", async () => {
    const textual = Buffer.from(`<html lang="en-US"><head><title>HubSpot CRM software for sales teams</title><script type="application/ld+json">{"@type":"Organization","name":"HubSpot"}</script></head></html>`);
    const withCategory = { fetch: vi.fn(async () => ({ status: 200, headers: {}, body: textual, finalUrl: "https://hubspot.com/" })), now: () => Date.now(), classify: async () => ({ slug: "crm", confidence: 0.9, source: "embedding", tokens: 1 }) } as unknown as DiscoverDeps;
    const phases = phasesOf(createCrawlDiscoverHandler(CONTEXT, withCategory))!;
    const row = liveRow({});
    const prepared = await phases.prepare(row.client, job());
    let steps = 0;
    const step = async (fn: (t: ClientBase) => Promise<void>) => {
      await fn(row.client);
      steps += 1;
      if (steps === 1) row.state.discovery = { ...row.state.discovery, fields: { ...(row.state.discovery.fields as Fields), brand_name: MINE } };
    };
    const result = await (phases.run as (p: unknown, j: Job, s: unknown) => Promise<unknown>)(prepared, job(), step);
    expect(steps).toBeGreaterThanOrEqual(2);
    expect((row.state.discovery.fields as Fields).brand_name).toEqual(MINE);
    await phases.commit(row.client, prepared, result as never, job());
    expect((row.state.discovery.fields as Fields).brand_name).toEqual(MINE);
  });

  it("STORY-044-AC4 the checkpoint re-reads the row under FOR UPDATE", async () => {
    const phases = phasesOf(createCrawlDiscoverHandler(CONTEXT, deps()))!;
    const row = liveRow({});
    const prepared = await phases.prepare(row.client, job());
    await (phases.run as (p: unknown, j: Job, s: unknown) => Promise<unknown>)(prepared, job(), async (fn: (t: ClientBase) => Promise<void>) => fn(row.client));
    const reads = (row.client.query as unknown as { mock: { calls: [string][] } }).mock.calls.filter(([s]) => /SELECT discovery/.test(s) && s.includes("FOR UPDATE"));
    expect(reads.length).toBeGreaterThanOrEqual(1);
  });
});

describe("STORY-195 AC13 · recover settles the stored payload's status", () => {
  it("STORY-195-AC13 a run-phase failure after a checkpoint on the final attempt leaves no 'running' in the stored payload", async () => {
    const phases = phasesOf(createCrawlDiscoverHandler(CONTEXT, deps()))!;
    const row = liveRow({ discovery_status: "running", fields: { brand_name: { value: "HubSpot", confidence: 0.9, source: "x", user_edited: false } } });
    const finalJob = { ...job(), attemptsMade: 3, opts: { attempts: 4 } } as unknown as Job;
    await expect(phases.recover!(row.client, finalJob, { error: new Error("boom"), phase: "run" } as never)).resolves.toBe(true);
    expect(row.state.discovery.discovery_status).toBe("partial");
    expect((row.state.discovery.fields as Fields).brand_name).toBeDefined();
  });
});
