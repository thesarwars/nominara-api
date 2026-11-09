import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { Pool } from "pg";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { publicPlansResponseSchema } from "../../../contracts/entitlements/public-plans.schema.js";
import { IS_PUBLIC_KEY } from "../../api/decorators/public.decorator.js";
import { SKIP_TENANT_CONTEXT_KEY } from "../../api/decorators/skip-tenant-context.decorator.js";
import { RATE_LIMIT_CLASS_KEY } from "../../api/rate-limit/route-class.js";
import { PublicPlansController } from "./public-plans.controller.js";
import { PublicPlansService } from "./public-plans.service.js";

// STORY-103 (API part) - `GET /public/plans`.

function fakePool(plans: unknown[], engines: unknown[]): { pool: Pool; queries: string[] } {
  const queries: string[] = [];
  const pool = {
    query: (text: string) => {
      queries.push(text);
      return Promise.resolve({ rows: /FROM\s+plans/iu.test(text) ? plans : engines });
    },
  } as unknown as Pool;
  return { pool, queries };
}

const GROWTH = {
  key: "growth", display_name: "Growth", currency: "USD", sort_order: 30,
  entitlements: { "price.monthly_usd": { value: 7919, live: true }, "fair_use.captures_per_cycle": { value: 4177, live: true }, "integrations.slack": { value: null, live: false } },
};

afterEach(() => vi.restoreAllMocks());

describe("STORY-103 · PublicPlansService", () => {
  it("STORY-103 #1 answers a contract-valid snapshot from the global plans and engines tables, with cadence_by_plan", async () => {
    const { pool, queries } = fakePool([GROWTH], [{ key: "gemini", display_name: "Gemini", cadence_by_plan: { growth: { full: 8 } } }]);
    const body = await new PublicPlansService(pool).snapshot(Date.UTC(2026, 10, 9));
    expect(publicPlansResponseSchema.safeParse(body).success).toBe(true);
    expect(body.plans[0]!.entitlements).toEqual({ "price.monthly_usd": 7919 });
    expect(body.engines).toEqual([{ engine_key: "gemini", display_name: "Gemini", cadence_by_plan: { growth: { full: 8 } } }]);
    expect(body.generated_at).toBe("2026-11-09T00:00:00.000Z");
    expect(queries).toHaveLength(2);
  });

  it("reads only public plans and non-disabled engines, in a stable order, with no tenant column", async () => {
    const { pool, queries } = fakePool([], []);
    await new PublicPlansService(pool).snapshot();
    const [plansSql, enginesSql] = queries.map((q) => q.replace(/\s+/gu, " "));
    expect(plansSql).toMatch(/WHERE is_public/iu);
    expect(plansSql).toMatch(/ORDER BY sort_order, key/iu);
    expect(enginesSql).toMatch(/status <> 'disabled'/iu);
    expect(enginesSql).toMatch(/ORDER BY key/iu);
    expect(queries.join(" ")).not.toMatch(/workspace_id|current_workspace/iu);
  });

  it("an empty catalog is an empty snapshot, not an error", async () => {
    const body = await new PublicPlansService(fakePool([], []).pool).snapshot();
    expect(body).toMatchObject({ plans: [], engines: [] });
  });

  it("fails closed: a malformed row refuses the whole snapshot and logs the outcome without the row", async () => {
    const warn = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const bad = { ...GROWTH, entitlements: { "secret.thing": 42 } };
    await expect(new PublicPlansService(fakePool([bad], []).pool).snapshot()).rejects.toThrow();
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain("public_plans.snapshot_failed");
    expect(logged).not.toContain("secret.thing");
  });

  it("logs a redacted line for a served snapshot: counts only, no workspace, no plan data", async () => {
    const log = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    await new PublicPlansService(fakePool([GROWTH], []).pool).snapshot();
    const lines = JSON.stringify(log.mock.calls);
    expect(lines).toContain("nominara_public_plans_served_total");
    expect(lines).toContain("public_plans.served");
    expect(lines).not.toContain("7919");
    expect(lines).not.toContain("Growth");
  });
});

describe("STORY-103 · the route declares its guards", () => {
  const handler = (PublicPlansController.prototype as unknown as Record<string, object>)["list"]!;

  it("is public, tenant-less and rate limited by the public_plans class", () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, handler)).toBe(true);
    expect(Reflect.getMetadata(SKIP_TENANT_CONTEXT_KEY, handler)).toBe(true);
    expect(Reflect.getMetadata(RATE_LIMIT_CLASS_KEY, handler)).toBe("public_plans");
  });
});

describe("STORY-103 · observability", () => {
  const exporter = new InMemorySpanExporter();
  beforeAll(() => {
    trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }));
  });

  it("emits one span carrying counts and no plan data; an error span records only the error name", async () => {
    exporter.reset();
    vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    await new PublicPlansService(fakePool([GROWTH], []).pool).snapshot();
    const ok = exporter.getFinishedSpans().filter((span) => span.name === "entitlements.public_plans.snapshot");
    expect(ok).toHaveLength(1);
    expect(ok[0]!.attributes).toMatchObject({ "nominara.public_plans.plans": 1, "nominara.public_plans.engines": 0 });
    expect(ok[0]!.status.code).not.toBe(SpanStatusCode.ERROR);

    exporter.reset();
    await expect(new PublicPlansService(fakePool([{ ...GROWTH, entitlements: { "secret.thing": 42 } }], []).pool).snapshot()).rejects.toThrow();
    const failed = exporter.getFinishedSpans().filter((span) => span.name === "entitlements.public_plans.snapshot");
    expect(failed).toHaveLength(1);
    expect(JSON.stringify(failed[0]!.events)).not.toContain("secret.thing");
  });
});
