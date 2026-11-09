import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectsService } from "./projects.service.js";
import { DomainError } from "../../api/errors/domain-errors.js";
import * as tenantContext from "../../tenancy/tenant-context.js";
import type { QueueProducer } from "../../lib/queue/queue-producer.js";
import type { EntitlementResolver } from "../../lib/entitlements/entitlement-resolver.js";
import type { UrlGuard } from "../../lib/net/url-guard.service.js";

vi.mock("../../lib/telemetry/metrics.js", () => ({ incrementCounter: vi.fn() }));
// The recompute is requested only when the queue has a handler; this spec asks as if it does.
vi.mock("../../lib/queue/handlers.js", () => ({ handlerFor: () => () => undefined }));

// STORY-189 AC2 — `projects.category_slug` is constrained to the taxonomy, so a value outside it is refused as a 422 the caller can act on,
// never a 500 from a foreign-key error. The database constraint (fk_projects_category) is the guarantee; the service names it.

const WS = "11111111-1111-7111-8111-111111111111";
const ACTOR = "22222222-2222-7222-8222-222222222222";

const fkViolation = Object.assign(new Error('insert or update on table "projects" violates foreign key constraint "fk_projects_category"'), {
  code: "23503",
  constraint: "fk_projects_category",
});
const otherFkViolation = Object.assign(new Error("violates foreign key constraint"), { code: "23503", constraint: "fk_projects_parent" });

const urlGuard = { validateAndNormalize: async () => ({ rootDomain: "acme.example" }) } as unknown as UrlGuard;
const resolver = {
  resolveForWorkspace: vi.fn(async () => ({ entitlements: { "projects.max": { value: 3 }, "prompts.max_per_project": { value: 500 }, "competitors.max_per_project": { value: 200 } } })),
  resolve: vi.fn(),
} as unknown as EntitlementResolver;
const queues = { enqueueTenantJob: vi.fn(async () => ({ id: "j" })) } as unknown as QueueProducer;

function clientFailing(on: (sql: string) => Error | undefined) {
  return {
    query: vi.fn(async (sql: string) => {
      const error = on(sql);
      if (error !== undefined) throw error;
      if (sql.includes("SELECT discovery")) return { rows: [{ discovery: { discovery_status: "completed", fields: {}, low_confidence_fields: [], competitors_proposed: [], prompts_generated: [], prompts_free_remaining: 10, credits_charged: 0, duration_ms: 1 }, category_slug: null }] };
      return { rows: [{ "?column?": 1 }] };
    }),
  };
}

describe("STORY-189 AC2 · an unknown category is a 422, not a 500", () => {
  beforeEach(() => {
    vi.spyOn(tenantContext, "afterCommit").mockImplementation(() => undefined);
  });

  it("creating a project with a category outside the taxonomy answers validation_failed naming category_slug", async () => {
    vi.spyOn(tenantContext, "currentTenantStore").mockReturnValue({ client: clientFailing((sql) => (sql.includes("INSERT INTO projects") ? fkViolation : undefined)) } as never);
    const attempt = new ProjectsService(queues, resolver, urlGuard).create(WS, ACTOR, { root_url: "https://acme.example", category_slug: "not_a_category" }, 1);
    await expect(attempt).rejects.toBeInstanceOf(DomainError);
    await expect(attempt).rejects.toMatchObject({ code: "validation_failed", details: { issues: [{ path: ["category_slug"] }] } });
  });

  it("confirming a category outside the taxonomy answers validation_failed naming the field, and writes nothing else", async () => {
    vi.spyOn(tenantContext, "currentTenantStore").mockReturnValue({ client: clientFailing((sql) => (sql.includes("UPDATE projects") ? fkViolation : undefined)) } as never);
    const attempt = new ProjectsService(queues, resolver, urlGuard).confirmDiscovery(WS, "p1", { fields: { category: { decision: "override", value: "not_a_category" } } }, 1);
    await expect(attempt).rejects.toMatchObject({ code: "validation_failed", details: { issues: [{ path: ["fields", "category", "value"] }] } });
    // No recompute is requested for a change that did not happen.
    expect(queues.enqueueTenantJob).not.toHaveBeenCalledWith("rollup.metric_daily", expect.anything(), expect.anything(), expect.anything());
  });

  it("any OTHER foreign-key failure is not relabelled as a category problem", async () => {
    vi.spyOn(tenantContext, "currentTenantStore").mockReturnValue({ client: clientFailing((sql) => (sql.includes("INSERT INTO projects") ? otherFkViolation : undefined)) } as never);
    await expect(new ProjectsService(queues, resolver, urlGuard).create(WS, ACTOR, { root_url: "https://acme.example" }, 1)).rejects.toBe(otherFkViolation);
  });

  describe("STORY-176 AC4 — a category override tells the rollup which slug the project left", () => {
    const DISCOVERED = { discovery_status: "completed", fields: { category: { value: "banks", confidence: 0.9, source: "s", user_edited: false } }, low_confidence_fields: [], competitors_proposed: [], prompts_generated: [], prompts_free_remaining: 0, credits_charged: 0, duration_ms: 1 };
    const confirmWith = async (held: string | null, body: Parameters<ProjectsService["confirmDiscovery"]>[2]) => {
      const fired: (() => void)[] = [];
      vi.spyOn(tenantContext, "afterCommit").mockImplementation((task: () => void) => void fired.push(task));
      vi.spyOn(tenantContext, "currentTenantStore").mockReturnValue({
        client: { query: vi.fn(async (sql: string) => ({ rows: sql.includes("SELECT discovery") ? [{ discovery: DISCOVERED, category_slug: held }] : [] })) },
      } as never);
      vi.mocked(queues.enqueueTenantJob).mockClear();
      await new ProjectsService(queues, resolver, urlGuard).confirmDiscovery(WS, "p1", body, 1);
      for (const task of fired) task();
      await Promise.resolve();
    };

    it("enqueues rollup.metric_daily with reason category_override and the previous slug", async () => {
      await confirmWith("crm", { fields: { category: { decision: "override", value: "banks" } } });
      expect(queues.enqueueTenantJob).toHaveBeenCalledWith(
        "rollup.metric_daily",
        WS,
        { projectId: "p1", reason: "category_override", previousCategorySlug: "crm" },
        expect.objectContaining({ idempotencyKey: expect.stringMatching(/^rollup:p1:category-override:crm>banks:/) }),
      );
    });

    it("a project that held no category before names no previous slug (it left nothing)", async () => {
      await confirmWith(null, { fields: { category: { decision: "override", value: "banks" } } });
      const payload = vi.mocked(queues.enqueueTenantJob).mock.calls[0]![2] as Record<string, unknown>;
      expect(payload).toEqual({ projectId: "p1", reason: "category_override" });
      expect("previousCategorySlug" in payload).toBe(false);
    });

    it("two overrides of one project are two distinct jobs, so the second is never swallowed by the first's key", async () => {
      await confirmWith("crm", { fields: { category: { decision: "override", value: "banks" } } });
      const first = (vi.mocked(queues.enqueueTenantJob).mock.calls[0]![3] as { idempotencyKey: string }).idempotencyKey;
      await new Promise((r) => setTimeout(r, 2));
      await confirmWith("crm", { fields: { category: { decision: "override", value: "banks" } } });
      const second = (vi.mocked(queues.enqueueTenantJob).mock.calls[0]![3] as { idempotencyKey: string }).idempotencyKey;
      expect(second).not.toBe(first);
    });
  });
});
