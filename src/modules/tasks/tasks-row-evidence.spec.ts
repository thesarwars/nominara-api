import { Logger } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { ClientBase } from "pg";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { taskListQuerySchema } from "../../../contracts/tasks/index.js";
import { NoopRealtimePublisher } from "../../lib/cache/realtime-publisher.js";
import { withTenantContext } from "../../tenancy/tenant-context.js";
import { evidenceOf, TasksService } from "./tasks.service.js";

// STORY-194 AC1 / AC6 - the observability of the task row's new members (one span, one metric, one redacted log line) and the evidence precedence.
const NONE = { source_finding_id: null, source_displacement_id: null, source_geo_analysis: null, source_domain_id: null };
const row = (over: Record<string, unknown>) => ({
  id: "t-1", short_ref: "HUB-1", project_id: "p", goal_id: null, title: "SECRET TITLE", description: "d", kind: "content", origin: "auto", status: "done", severity: null,
  ...NONE, rule_code: null, priority: 3, impact_score: 1, effort_band: null, assignee_id: null, due_at: null, dismissed_reason: null, resurface_at: null,
  completed_at: null, affected_url: null, created_at: new Date(0), updated_at: new Date(0), seeding: false, review: null, playbook_slug: null, measured_impact: null,
  k1_key: "0", k2_key: "0", k3_key: "0", k4_key: "x", ...over,
});
function client(taskRows: unknown[], seen: string[]): ClientBase {
  return {
    query: async (sql: string) => {
      seen.push(sql);
      if (sql.includes("FROM projects")) return { rows: [{ id: "p" }] };
      if (sql.includes("WITH items")) return { rows: taskRows };
      return { rows: [] };
    },
  } as unknown as ClientBase;
}
const run = (taskRows: unknown[], seen: string[]) =>
  withTenantContext(client(taskRows, seen), { workspaceId: "ws-1", actorId: "a" }, () =>
    new TasksService(new NoopRealtimePublisher()).listProjectTasks("p", taskListQuerySchema.parse({})),
  );

describe("STORY-194 · task row evidence precedence", () => {
  it("[STORY-194 AC1] finding wins over displacement, geo analysis and source gap, in that order; nothing set is null", () => {
    expect(evidenceOf({ source_finding_id: "f", source_displacement_id: "d", source_geo_analysis: "g", source_domain_id: "s" })).toEqual({ kind: "finding", id: "f" });
    expect(evidenceOf({ ...NONE, source_displacement_id: "d", source_geo_analysis: "g", source_domain_id: "s" })).toEqual({ kind: "displacement", id: "d" });
    expect(evidenceOf({ ...NONE, source_geo_analysis: "g", source_domain_id: "s" })).toEqual({ kind: "geo_analysis", id: "g" });
    expect(evidenceOf({ ...NONE, source_domain_id: "s" })).toEqual({ kind: "source_gap", id: "s" });
    expect(evidenceOf(NONE)).toBeNull();
  });
});

describe("STORY-194 · observability of the task row's patch and impact reads", () => {
  const exporter = new InMemorySpanExporter();
  beforeAll(() => { trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })); });
  afterEach(() => { vi.restoreAllMocks(); exporter.reset(); });

  it("[STORY-194 AC6] a task with no finding makes no patch query; the span records counts only", async () => {
    const seen: string[] = [];
    const page = await run([row({})], seen);
    expect(seen.some((q) => q.includes("FROM patches"))).toBe(false);
    const span = exporter.getFinishedSpans().find((s) => s.name === "tasks.task_rows.patches")!;
    expect(span.attributes).toEqual({ "tasks.findings": 0, "tasks.patches_served": 0 });
    expect(span.status.code).not.toBe(SpanStatusCode.ERROR);
    expect(page.items[0]!.patch).toBeNull();
  });

  it("[STORY-194 AC6] an invalid measured_impact is served null, counted, and logged with the ids only - never the jsonb, a title or a workspace name", async () => {
    const logs: unknown[] = [];
    vi.spyOn(Logger.prototype, "log").mockImplementation((m: unknown) => void logs.push(m));
    const warns: unknown[] = [];
    vi.spyOn(Logger.prototype, "warn").mockImplementation((m: unknown) => void warns.push(m));
    const page = await run([row({ measured_impact: { delta: 3, secret: "ENGINE TEXT" } })], []);
    expect(page.items[0]!.measured_impact).toBeNull();
    expect(logs).toContainEqual({ metric: "nominara_tasks_measured_impact_invalid_total", value: 1 });
    expect(warns).toEqual([{ message: "task measured impact failed validation and was not served", workspace_id: "ws-1", task_id: "t-1" }]);
    expect(JSON.stringify([...logs, ...warns])).not.toMatch(/ENGINE TEXT|SECRET TITLE/);
  });
});
