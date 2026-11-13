import { afterEach, describe, expect, it, vi } from "vitest";
import * as tenantContext from "../../tenancy/tenant-context.js";
import { GscPromptCandidatesService } from "./gsc-prompt-candidates.service.js";

// STORY-115 AC11 / FR-PA-04 (PROVISIONAL, batch 13) - classic Search Console queries offered as prompt candidates.
const PROJECT = "0198f6a0-0000-7000-8000-0000000000a1";

interface Fixture {
  project?: boolean;
  connection?: { health_status: string; last_sync_date: string | null };
  queries?: Array<{ query_text: string; impressions: number; clicks: number }>;
  prompts?: Array<{ id: string; text: string }>;
}

function harness(f: Fixture) {
  const sql: Array<{ text: string; params: unknown[] }> = [];
  const client = {
    query: vi.fn(async (text: string, params: unknown[]) => {
      sql.push({ text, params });
      if (/FROM projects/.test(text)) return { rowCount: f.project === false ? 0 : 1, rows: [] };
      if (/FROM gsc_connections/.test(text)) return { rowCount: f.connection ? 1 : 0, rows: f.connection ? [f.connection] : [] };
      if (/FROM gsc_daily/.test(text)) return { rowCount: (f.queries ?? []).length, rows: f.queries ?? [] };
      if (/FROM tracked_prompts/.test(text)) return { rowCount: (f.prompts ?? []).length, rows: f.prompts ?? [] };
      throw new Error(`unexpected query: ${text}`);
    }),
  };
  vi.spyOn(tenantContext, "currentTenantStore").mockReturnValue({ client, context: { workspaceId: "w" } } as never);
  return { service: new GscPromptCandidatesService(), sql };
}

const query = (over: Partial<{ timeframe: "7d" | "30d" | "90d"; limit: number }> = {}) => ({ timeframe: "90d" as const, limit: 25, ...over });

describe("STORY-115 AC11 · GscPromptCandidatesService", () => {
  afterEach(() => vi.restoreAllMocks());

  it("no connection: not connected, no candidates, no frontier (never an invented window)", async () => {
    const { service } = harness({});
    const out = await service.read(PROJECT, query());
    expect(out).toMatchObject({ connected: false, health_status: null, frontier: null, window_start: null, window_end: null, candidates: [] });
  });

  it("connected but never synced: connected, empty, no window", async () => {
    const { service, sql } = harness({ connection: { health_status: "healthy", last_sync_date: null } });
    const out = await service.read(PROJECT, query());
    expect(out).toMatchObject({ connected: true, frontier: null, candidates: [] });
    expect(sql.some((q) => /FROM gsc_daily/.test(q.text))).toBe(false);
  });

  it("the window ends at the stored frontier, and only the classic report's query dimension is read", async () => {
    const { service, sql } = harness({ connection: { health_status: "healthy", last_sync_date: "2026-11-10" } });
    const out = await service.read(PROJECT, query({ timeframe: "7d" }));
    expect(out).toMatchObject({ window_days: 7, window_end: "2026-11-10", window_start: "2026-11-04", frontier: "2026-11-10" });
    const q = sql.find((s) => /FROM gsc_daily/.test(s.text))!;
    expect(q.text).toMatch(/report = 'classic' AND dimension = 'query'/);
    expect(q.text).not.toMatch(/ai_surface/);
    expect(q.params).toContain("2026-11-10");
  });

  it("each candidate is a real Google query from the classic report with its own impressions and clicks; a zero stays zero", async () => {
    const { service } = harness({
      connection: { health_status: "healthy", last_sync_date: "2026-11-10" },
      queries: [{ query_text: "roof repair cost", impressions: 120, clicks: 0 }],
    });
    const out = await service.read(PROJECT, query());
    expect(out.candidates).toEqual([{ text: "roof repair cost", source: "gsc_query", report: "classic", label: "real Google query", impressions: 120, clicks: 0 }]);
    expect(out.limits_note).toMatch(/not a count of AI prompts/);
  });

  it("a query a tracked prompt already covers is not offered; a near-miss below the floor still is", async () => {
    const { service } = harness({
      connection: { health_status: "healthy", last_sync_date: "2026-11-10" },
      queries: [
        { query_text: "best roofing company near me", impressions: 90, clicks: 4 },
        { query_text: "roof repair cost", impressions: 80, clicks: 2 },
      ],
      prompts: [{ id: "0198f6a0-0000-7000-8000-0000000000b1", text: "Best roofing company near me" }],
    });
    const out = await service.read(PROJECT, query());
    expect(out.candidates.map((c) => c.text)).toEqual(["roof repair cost"]);
  });

  it("the limit is applied AFTER the already-tracked ones are removed, so a covered query does not consume a slot", async () => {
    const { service } = harness({
      connection: { health_status: "healthy", last_sync_date: "2026-11-10" },
      queries: [
        { query_text: "covered query one", impressions: 100, clicks: 0 },
        { query_text: "fresh query two", impressions: 50, clicks: 0 },
        { query_text: "fresh query three", impressions: 40, clicks: 0 },
      ],
      prompts: [{ id: "0198f6a0-0000-7000-8000-0000000000b1", text: "covered query one" }],
    });
    const out = await service.read(PROJECT, query({ limit: 1 }));
    expect(out.candidates.map((c) => c.text)).toEqual(["fresh query two"]);
  });

  it("an unknown project is a 404, not an empty list", async () => {
    const { service } = harness({ project: false });
    await expect(service.read(PROJECT, query())).rejects.toMatchObject({ status: 404 });
  });

  it("an empty report is an empty list, distinct from not connected", async () => {
    const { service } = harness({ connection: { health_status: "healthy", last_sync_date: "2026-11-10" }, queries: [] });
    const out = await service.read(PROJECT, query());
    expect(out).toMatchObject({ connected: true, candidates: [] });
  });
});
