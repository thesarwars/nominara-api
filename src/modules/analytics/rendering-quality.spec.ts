import { Test } from "@nestjs/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyFakeApiEnv } from "../../../test/support/fake-env.js";
import {
  renderingQualityQuerySchema,
  renderingQualityResponseSchema,
  type ScorecardsResponse,
} from "../../../contracts/analytics/index.js";
import { REQUIRE_PERMISSION_KEY } from "../../api/decorators/require-permission.decorator.js";
import * as tenantContext from "../../tenancy/tenant-context.js";
import { AnalyticsModule } from "./analytics.module.js";
import { RenderingQualityController } from "./rendering-quality.controller.js";
import { RenderingQualityService } from "./rendering-quality.service.js";
import type { ScorecardsService } from "./scorecards.service.js";

// NEW-C-11 — GET /projects/{id}/rendering-quality. SQL-text and fake-client
// scenarios; the real-SQL, real-role proof is
// test/integration/rendering-quality.spec.ts.

const PROJECT_ID = "0195e5b7-0000-7000-8000-0000000000f1";
const WORKSPACE_ID = "0195e5b7-0000-7000-8000-0000000000c1";

interface Recorded { sql: string; params: unknown[] }
let calls: Recorded[];

const entry = (engine_key: string, rendering: number | null, source: "live" | "demo" | "mixed" | null) =>
  ({ engine_key, display_name: engine_key, data_source: source, metrics: { rendering_quality: rendering } }) as never;

function scorecardsFake(engines: unknown[], blendedRendering: number | null, blendedSource: "live" | "demo" | "mixed" | null = "mixed") {
  return {
    scorecards: vi.fn(async () => ({
      project_id: PROJECT_ID,
      timeframe: "30d",
      window: { from: "2026-09-09", to: "2026-10-08", timezone: "UTC" },
      engines,
      blended: { engine_key: "all", data_source: blendedSource, metrics: { rendering_quality: blendedRendering } },
    }) as unknown as ScorecardsResponse),
  } as unknown as ScorecardsService;
}

function serviceWith(scorecards: ScorecardsService, route: (sql: string) => unknown[] | undefined = () => []) {
  calls = [];
  vi.spyOn(tenantContext, "currentTenantStore").mockReturnValue({
    client: {
      query: vi.fn(async (sql: string, params: unknown[]) => {
        calls.push({ sql, params });
        return { rows: route(sql) ?? [] };
      }),
    },
    context: { workspaceId: WORKSPACE_ID, actorId: "0195e5b7-0000-7000-8000-0000000000d1" },
  } as never);
  return new RenderingQualityService(scorecards);
}

const isCounts = (sql: string) => sql.includes("mention_facts");
const isFindings = (sql: string) => sql.includes("aux_findings");

describe("NEW-C-11 · RenderingQualityService", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("[NEW-C-11 AC1] the response satisfies the contract and reuses the scorecards' figures (no second formula)", async () => {
    const service = serviceWith(
      scorecardsFake([entry("google_ai_mode", 41.5, "demo"), entry("gemini", null, "live")], 41.5),
      (sql) => (isCounts(sql) ? [{ engine_key: "google_ai_mode", mentions: "10", price: "4" }] : []),
    );
    const out = await service.renderingQuality(PROJECT_ID, { timeframe: "30d" });
    expect(renderingQualityResponseSchema.safeParse(out).success).toBe(true);
    expect(out.engines.find((e) => e.engine_key === "google_ai_mode")!.score).toBe(41.5);
    expect(out.blended.score).toBe(41.5);
    expect(out.window).toEqual({ from: "2026-09-09", to: "2026-10-08", timezone: "UTC" });
    expect(out.rich_rendering_engines).toEqual(["google_ai_mode"]);
  });

  it("[NEW-C-11 AC2] with no mentions the score is null and the coverage null, never 0", async () => {
    const service = serviceWith(scorecardsFake([entry("google_ai_mode", null, null)], null, null));
    const out = await service.renderingQuality(PROJECT_ID, { timeframe: "30d" });
    expect(out.engines[0]!.score).toBeNull();
    expect(out.engines[0]!.attributes.every((a) => a.coverage === null)).toBe(true);
    expect(out.blended.score).toBeNull();
    expect(out.blended.data_source).toBeNull();
  });

  it("[NEW-C-11 AC2] the counts are brand-only, on measured captures, limited to attribute-capable engines, with bound parameters", async () => {
    const service = serviceWith(scorecardsFake([entry("google_ai_mode", 1, "demo")], 1));
    await service.renderingQuality(PROJECT_ID, { timeframe: "30d" });
    const counts = calls.filter((c) => isCounts(c.sql));
    expect(counts.length).toBeGreaterThan(0);
    for (const call of counts) {
      expect(call.sql).toContain("entity_type = 'brand'");
      expect(call.sql).toMatch(/NOT IN \('failed', 'blocked'\)/);
      expect(call.sql).not.toContain("workspace_id");
      expect(call.sql).not.toContain("sql.raw");
      expect(call.params).toContain(PROJECT_ID);
      expect(call.params.flat()).toEqual(expect.arrayContaining(["google_ai_mode", "google_aio"]));
    }
  });

  it("[NEW-C-11 AC3] the cause query reads OPEN findings of the mapped rules only, bound, no workspace predicate", async () => {
    const service = serviceWith(scorecardsFake([entry("google_ai_mode", 1, "demo")], 1));
    await service.renderingQuality(PROJECT_ID, { timeframe: "30d" });
    const finding = calls.find((c) => isFindings(c.sql))!;
    expect(finding.sql).toContain("status = 'open'");
    expect(finding.sql).not.toContain("workspace_id");
    expect(finding.params.flat()).toEqual(expect.arrayContaining([PROJECT_ID, "AUX-R-012", "AUX-R-013", "AUX-R-015"]));
  });

  it("[NEW-C-11 AC3] an open price finding becomes the cause of a missing price", async () => {
    const service = serviceWith(
      scorecardsFake([entry("google_ai_mode", 10, "demo")], 10),
      (sql) => {
        if (isCounts(sql)) return [{ engine_key: "google_ai_mode", mentions: "10", price: "3" }];
        if (isFindings(sql)) return [{ id: "0195e5b7-0000-7000-8000-0000000000b1", rule_code: "AUX-R-012", severity: "high", title: "Offer data absent" }];
        return [];
      },
    );
    const out = await service.renderingQuality(PROJECT_ID, { timeframe: "30d" });
    const price = out.engines[0]!.attributes.find((a) => a.attribute === "price")!;
    expect(price.coverage).toBe(0.3);
    expect(price.cause).toMatchObject({ rule_code: "AUX-R-012" });
  });

  it("[NEW-C-11 AC4] each engine's data_source and the blend's come from the scorecards' provenance", async () => {
    const service = serviceWith(scorecardsFake([entry("google_ai_mode", 1, "demo"), entry("gemini", null, "live")], 1, "mixed"));
    const out = await service.renderingQuality(PROJECT_ID, { timeframe: "30d" });
    expect(out.engines.map((e) => [e.engine_key, e.data_source])).toEqual([["google_ai_mode", "demo"], ["gemini", "live"]]);
    expect(out.blended.data_source).toBe("mixed");
  });

  it("[NEW-C-11 AC1] the query is strict: an unknown key is rejected, the timeframe defaults to 30d", () => {
    expect(renderingQualityQuerySchema.safeParse({ timeframe: "7d", engines: "x" }).success).toBe(false);
    expect(renderingQualityQuerySchema.parse({})).toEqual({ timeframe: "30d" });
    expect(renderingQualityQuerySchema.safeParse({ timeframe: "1y" }).success).toBe(false);
  });

  it("[NEW-C-11 AC1] a missing tenant context fails closed", async () => {
    vi.spyOn(tenantContext, "currentTenantStore").mockReturnValue(undefined);
    await expect(new RenderingQualityService(scorecardsFake([], null)).renderingQuality(PROJECT_ID, { timeframe: "30d" })).rejects.toThrow(/tenant context/);
  });
});

describe("NEW-C-11 · RenderingQualityController", () => {
  const originalEnv = { ...process.env };
  beforeEach(() => applyFakeApiEnv());
  afterEach(() => { process.env = { ...originalEnv }; });

  it("[NEW-C-11 AC1] is mounted in the analytics module and reads under tracking:read", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AnalyticsModule] }).compile();
    expect(moduleRef.get(RenderingQualityController)).toBeInstanceOf(RenderingQualityController);
    expect(moduleRef.get(RenderingQualityService)).toBeInstanceOf(RenderingQualityService);
    expect(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, RenderingQualityController.prototype.renderingQuality)).toBe("tracking:read");
    expect(Reflect.getMetadata("path", RenderingQualityController)).toBe("projects/:id/rendering-quality");
    await moduleRef.close();
  });
});
