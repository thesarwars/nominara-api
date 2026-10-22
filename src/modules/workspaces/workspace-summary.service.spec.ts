import { beforeEach, describe, expect, it, vi } from "vitest";
import { FeatureNotInPlanError } from "../../api/errors/domain-errors.js";
import * as metrics from "../../lib/telemetry/metrics.js";
import * as tenantContext from "../../tenancy/tenant-context.js";
import { workspaceSummaryResponseSchema } from "../../../contracts/workspaces/workspace-summary-response.schema.js";
import type { ProjectListItem } from "../../../contracts/projects/index.js";
import type { DataSource } from "../../../contracts/analytics/index.js";

const resolveEntitlements = vi.fn();
vi.mock("../../lib/entitlements/resolution.js", () => ({ resolveEntitlements: (...a: unknown[]) => resolveEntitlements(...a) }));
const captureReady = vi.fn<() => string[]>(() => ["gemini"]);
vi.mock("../../lib/engines/registry.js", () => ({ captureReadyEngineKeys: () => captureReady() }));

// NEW-B-2 audit — provenance is read from the captures, never from adapter readiness.
const engineSources = vi.fn<(tx: unknown, projectId: string, from: string, to: string, tz: string) => Map<string, DataSource>>(() => new Map());
// NEW-B-2 CP2 — provenance is ONE batched read for every project in the matrix
// (AC "no per-project query"); the per-project answer is still driven through
// `engineSources` so each case below states what each project reads.
const batch = vi.fn(async (tx: unknown, projectIds: readonly string[], from: string, to: string, tz: string) => {
  const result = new Map<string, Map<string, DataSource>>();
  for (const id of projectIds) result.set(id, engineSources(tx, id, from, to, tz));
  return result;
});
vi.mock("../../lib/analytics/data-source.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/analytics/data-source.js")>()),
  engineDataSourcesForProjects: (...a: Parameters<typeof batch>) => batch(...a),
}));

import { WorkspaceSummaryService } from "./workspace-summary.service.js";

// NEW-B-2 — GET /v1/workspaces/{id}/summary. FR-DASH-01 / STORY-089: the whole
// matrix from one request, scoped counts, null is not zero.

const WS = "11111111-1111-7111-8111-111111111111";

function project(overrides: Partial<ProjectListItem> = {}): ProjectListItem {
  return {
    id: "22222222-2222-7222-8222-222222222222",
    name: "P",
    slug: "p",
    root_domain: "p.com",
    kind: "brand",
    status: "active",
    paused_by_downgrade_at: null,
    discovery_status: "completed",
    prompts_active: 5,
    prompts_cap: 30,
    open_task_count: 0,
    open_tasks_by_severity: { critical: 0, high: 0, medium: 0, low: 0 },
    domain_verified_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    visibility_blended: null,
    visibility_delta_30d: null,
    rendering_quality: null,
    rendering_delta_30d: null,
    source_coverage: null,
    aux_score_current: null,
    sentiment_score: null,
    sentiment_delta_30d: null,
    sentiment_band: null,
    confidence: null,
    engine_scores: null,
    sparkline_30d: null,
    demo_seeded: false,
    last_scan: null,
    ...overrides,
  } as ProjectListItem;
}

function entitlements(values: Record<string, unknown>) {
  return {
    workspace_id: WS,
    plan_key: "growth",
    entitlement_version: 1,
    entitlements: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { value: v }])),
  };
}

function setup(opts: { projects?: ProjectListItem[]; engines?: string[]; wallet?: unknown; ent?: Record<string, unknown> } = {}) {
  const projects = {
    listForSummary: vi.fn(async () => ({ projects: opts.projects ?? [], engineKeys: opts.engines ?? [] })),
  };
  const billing = {
    wallet: vi.fn(async () => {
      if (opts.wallet instanceof Error) throw opts.wallet;
      return opts.wallet ?? { available: 100, expiring_soon: null, cycle_end: "2026-11-01", included_balance: 100, purchased_balance: 0 };
    }),
  };
  resolveEntitlements.mockResolvedValue(entitlements(opts.ent ?? { "projects.max": 3, "prompts.max_total": 120 }));
  const client = {
    query: vi.fn(async () => ({ rows: [{ timezone: "Asia/Dhaka", from: "2026-09-08", to: "2026-10-07" }] })),
  };
  vi.spyOn(tenantContext, "currentTenantStore").mockReturnValue({ client, context: { workspaceId: WS, actorId: "a" } } as never);
  return { service: new WorkspaceSummaryService(projects as never, billing as never), projects, billing, client };
}

describe("NEW-B-2 · WorkspaceSummaryService", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resolveEntitlements.mockReset();
    captureReady.mockReturnValue(["gemini"]);
    engineSources.mockReset();
    engineSources.mockReturnValue(new Map());
    batch.mockClear();
  });

  it("FR-DASH-01: one projects read serves the whole matrix, and the response satisfies the contract", async () => {
    const { service, projects } = setup({ projects: [project(), project({ id: "33333333-3333-7333-8333-333333333333" })] });
    const out = await service.summary(WS);
    expect(projects.listForSummary).toHaveBeenCalledTimes(1);
    expect(out.window_days).toBe(30);
    expect(workspaceSummaryResponseSchema.safeParse(out).success).toBe(true);
  });

  it("STORY-175 AC1: last_scan passes through to the row untouched, null stays null", async () => {
    const scan = {
      run_id: "33333333-3333-7333-8333-333333333333",
      status: "running" as const,
      trigger: "manual" as const,
      planned_cells: 17,
      settled_cells: 11,
      captured_cells: 11,
      started_at: "2026-10-12T13:00:00.000Z",
      completed_at: null,
      rolled_up: false,
    };
    const { service } = setup({ projects: [project({ last_scan: scan }), project({ id: "44444444-4444-7444-8444-444444444444" })] });
    const out = await service.summary(WS);
    expect(out.projects[0]!.last_scan).toEqual(scan);
    expect(out.projects[1]!.last_scan).toBeNull();
    expect(workspaceSummaryResponseSchema.safeParse(out).success).toBe(true);
  });

  it("scoped counts: projects_used and prompts_used come from the rows returned, not the workspace", async () => {
    const { service } = setup({ projects: [project({ prompts_active: 5 }), project({ prompts_active: 7 })] });
    const out = await service.summary(WS);
    expect(out.health.projects_used).toBe(2);
    expect(out.health.prompts_used).toBe(12);
  });

  it("an empty matrix is projects_used 0, not an error", async () => {
    const out = await setup().service.summary(WS);
    expect(out.projects).toEqual([]);
    expect(out.health.projects_used).toBe(0);
    expect(out.health.prompts_used).toBe(0);
  });

  it("non-numeric limits ('custom', 'uncapped') are null, a numeric 0 stays 0", async () => {
    const custom = await setup({ ent: { "projects.max": "custom", "prompts.max_total": "uncapped" } }).service.summary(WS);
    expect(custom.health.projects_limit).toBeNull();
    expect(custom.health.prompts_limit).toBeNull();
    const zero = await setup({ ent: { "projects.max": 0, "prompts.max_total": 0 } }).service.summary(WS);
    expect(zero.health.projects_limit).toBe(0);
    expect(zero.health.prompts_limit).toBe(0);
  });

  const TWO_ENGINE_SCORES = [
    { engine_key: "gemini", score: 60, delta_30d: null },
    { engine_key: "chatgpt", score: 40, delta_30d: 1 },
  ];

  it("NEW-B-2 audit · Gemini has an API key but only seeded captures: it reads 'demo' on the score and on the filter list, not 'live'", async () => {
    captureReady.mockReturnValue(["gemini"]);
    engineSources.mockReturnValue(new Map<string, DataSource>([["gemini", "demo"], ["chatgpt", "demo"]]));
    const out = await setup({ projects: [project({ engine_scores: TWO_ENGINE_SCORES })], engines: ["chatgpt", "gemini"] }).service.summary(WS);
    expect(out.projects[0]!.engine_scores!.map((s) => [s.engine_key, s.data_source])).toEqual([["gemini", "demo"], ["chatgpt", "demo"]]);
    expect(out.engines).toEqual([
      { engine_key: "chatgpt", data_source: "demo" },
      { engine_key: "gemini", data_source: "demo" },
    ]);
  });

  it("NEW-B-2 audit · live captures read 'live', both kinds read 'mixed'", async () => {
    engineSources.mockReturnValue(new Map<string, DataSource>([["gemini", "live"], ["chatgpt", "mixed"]]));
    const out = await setup({ projects: [project({ engine_scores: TWO_ENGINE_SCORES })], engines: ["chatgpt", "gemini"] }).service.summary(WS);
    expect(out.projects[0]!.engine_scores!.map((s) => s.data_source)).toEqual(["live", "mixed"]);
  });

  it("NEW-B-2 audit · an engine with nothing measured is null, even when its adapter is ready (null is not demo, not live)", async () => {
    captureReady.mockReturnValue(["gemini"]);
    engineSources.mockReturnValue(new Map<string, DataSource>([["chatgpt", "demo"]]));
    const out = await setup({ projects: [project({ engine_scores: TWO_ENGINE_SCORES })], engines: ["chatgpt", "gemini"] }).service.summary(WS);
    expect(out.projects[0]!.engine_scores!.map((s) => s.data_source)).toEqual([null, "demo"]);
    expect(out.engines).toEqual([
      { engine_key: "chatgpt", data_source: "demo" },
      { engine_key: "gemini", data_source: null },
    ]);
    expect(workspaceSummaryResponseSchema.safeParse(out).success).toBe(true);
  });

  it("NEW-B-2 audit · the filter list combines the scoped projects' provenance per engine (live + demo = mixed)", async () => {
    const A = "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa";
    const B = "bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb";
    engineSources.mockImplementation((_tx, projectId) => new Map<string, DataSource>([["gemini", projectId === A ? "live" : "demo"]]));
    const out = await setup({ projects: [project({ id: A }), project({ id: B })], engines: ["gemini"] }).service.summary(WS);
    expect(out.engines).toEqual([{ engine_key: "gemini", data_source: "mixed" }]);
  });

  it("NEW-B-2 audit · provenance is read over the 30-day workspace-local window in the workspace timezone", async () => {
    const { service, client } = setup({ projects: [project()], engines: ["gemini"] });
    await service.summary(WS);
    expect(engineSources).toHaveBeenCalledWith(client, "22222222-2222-7222-8222-222222222222", "2026-09-08", "2026-10-07", "Asia/Dhaka");
  });

  it("NEW-B-2 CP2 · AC no per-project query: ONE batched provenance read serves every project, however many", async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `00000000-0000-7000-8000-${String(i).padStart(12, "0")}`);
    const { service, client } = setup({ projects: ids.map((id) => project({ id })), engines: ["gemini"] });
    await service.summary(WS);
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch).toHaveBeenCalledWith(client, ids, "2026-09-08", "2026-10-07", "Asia/Dhaka");
  });

  it("NEW-B-2 CP2 · an empty matrix makes no provenance read at all", async () => {
    await setup({ engines: ["gemini"] }).service.summary(WS);
    expect(batch).not.toHaveBeenCalled();
  });

  it("with no captures anywhere everything is null (nothing measured is never folded into demo)", async () => {
    const out = await setup({ engines: ["gemini"] }).service.summary(WS);
    expect(out.engines).toEqual([{ engine_key: "gemini", data_source: null }]);
  });

  it("null scores stay null — absence is not zero", async () => {
    const out = await setup({ projects: [project()] }).service.summary(WS);
    expect(out.projects[0]!.visibility_blended).toBeNull();
    expect(out.projects[0]!.engine_scores).toBeNull();
  });

  it("credits carry only the available balance, expiry and cycle end — no bucket split", async () => {
    const out = await setup().service.summary(WS);
    expect(out.health.credits).toEqual({ available: 100, expiring_soon: null, cycle_end: "2026-11-01" });
  });

  it("a negotiated grant (FeatureNotInPlan) is credits null; any other wallet failure propagates", async () => {
    const negotiated = new FeatureNotInPlanError({ message: "negotiated", details: { key: "credits.included_per_cycle", min_plan: "enterprise" } });
    expect((await setup({ wallet: negotiated }).service.summary(WS)).health.credits).toBeNull();
    await expect(setup({ wallet: new Error("db down") }).service.summary(WS)).rejects.toThrow("db down");
  });

  it("observability: counts the read and logs the workspace id, never a name", async () => {
    const counter = vi.spyOn(metrics, "incrementCounter");
    await setup({ projects: [project()] }).service.summary(WS);
    expect(counter).toHaveBeenCalledWith("nominara_workspace_summary_reads_total", { empty: "false" });
  });
});
