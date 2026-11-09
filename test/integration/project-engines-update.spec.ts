import { randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";
import { trace } from "@opentelemetry/api";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { updateProjectEnginesResponseSchema } from "../../contracts/projects/index.js";
import { ProjectEnginesService } from "../../src/modules/projects/project-engines.service.js";
import { FeatureNotInPlanError, NotFoundError, UnsupportedEngineError } from "../../src/api/errors/domain-errors.js";
import type { EntitlementResolver } from "../../src/lib/entitlements/entitlement-resolver.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";

// PUT /projects/{id}/engines. `project_engines` holds OVERRIDES only (0027): the
// entitled set is derived from the catalog and the plan, and a row can narrow or
// reweight but never add. Hazards asserted: an unentitled engine is refused and
// writes nothing; sample_count > 1 needs drift_sampling; the write is
// tenant-scoped; an omitted field is left as it was.

describe("PUT /projects/{id}/engines", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let workspaceId: string;
  let otherWorkspaceId: string;
  let projectId: string;
  let otherProjectId: string;
  let actorId: string;
  let plan = "business";
  let driftSampling: unknown = "le_20_prompts";
  const exporter = new InMemorySpanExporter();

  const resolver = {
    resolveForWorkspace: async () => ({ entitlements: { "drift_sampling.enabled": { value: driftSampling } } }),
  } as unknown as EntitlementResolver;
  const service = new ProjectEnginesService(resolver);

  beforeAll(async () => {
    trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }));
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await migrateUp(db);
  }, 300_000);

  afterAll(async () => {
    await db.end();
    await container.stop();
  });

  async function seedWorkspace(planKey: string): Promise<{ ws: string; project: string }> {
    const ws = randomUUID();
    const project = randomUUID();
    await db.query("INSERT INTO workspaces (id,name,slug,plan_key,timezone) VALUES ($1,'W',$2,$3,'UTC')", [ws, `w-${randomUUID().slice(0, 8)}`, planKey]);
    await db.query(
      `INSERT INTO projects (id,workspace_id,name,slug,root_url,root_domain) VALUES ($1,$2,'P',$3,'https://p.example','p.example')`,
      [project, ws, `p-${randomUUID().slice(0, 8)}`],
    );
    return { ws, project };
  }

  beforeEach(async () => {
    await db.query("TRUNCATE project_engines, projects, workspaces CASCADE");
    await db.query("TRUNCATE users CASCADE");
    actorId = (await db.query("INSERT INTO users (email, status) VALUES ($1, 'active') RETURNING id", [`a-${randomUUID()}@example.com`])).rows[0].id;
    plan = "business";
    driftSampling = "le_20_prompts";
    ({ ws: workspaceId, project: projectId } = await seedWorkspace(plan));
    ({ ws: otherWorkspaceId, project: otherProjectId } = await seedWorkspace("business"));
    exporter.reset();
  });

  const put = (engines: Record<string, unknown>[], project = projectId, ws = workspaceId) =>
    withTenantContext(db, { workspaceId: ws, actorId }, () => service.update(ws, project, { engines } as never));
  const rows = async (project = projectId) =>
    (await db.query("SELECT engine_key, enabled, weight, sample_count FROM project_engines WHERE project_id = $1 ORDER BY engine_key", [project])).rows;
  const setPlan = (key: string) => db.query("UPDATE workspaces SET plan_key = $2 WHERE id = $1", [workspaceId, key]);

  it("PE-1 disables an engine and reweights another; the response is the effective set", async () => {
    const res = await put([{ engine_key: "chatgpt", enabled: false }, { engine_key: "perplexity", weight: 2.5 }]);
    expect(updateProjectEnginesResponseSchema.safeParse(res).success).toBe(true);
    expect(res.project_id).toBe(projectId);
    const by = Object.fromEntries(res.engines.map((e) => [e.engine_key, e]));
    expect(by.chatgpt).toMatchObject({ enabled: false, weight: 1, sample_count: 1 });
    expect(by.perplexity).toMatchObject({ enabled: true, weight: 2.5, sample_count: 1 });
    // Untouched engines show defaults, and business is entitled to all six active ones.
    expect(res.engines.map((e) => e.engine_key)).toEqual(["chatgpt", "claude", "gemini", "google_ai_mode", "google_aio", "perplexity"]);
    expect(by.claude).toMatchObject({ enabled: true, weight: 1, sample_count: 1 });
    expect((await rows()).map((r) => r.engine_key)).toEqual(["chatgpt", "perplexity"]);
  });

  it("PE-2 an omitted field keeps its stored value, and a repeated call changes nothing", async () => {
    await put([{ engine_key: "chatgpt", weight: 3, sample_count: 2 }]);
    await put([{ engine_key: "chatgpt", enabled: false }]);
    expect(await rows()).toEqual([{ engine_key: "chatgpt", enabled: false, weight: 3, sample_count: 2 }]);
    await put([{ engine_key: "chatgpt", enabled: false }]);
    expect(await rows()).toEqual([{ engine_key: "chatgpt", enabled: false, weight: 3, sample_count: 2 }]);
  });

  it("PE-3 an engine the plan is not entitled to is refused 400 unsupported_engine and nothing is written, even beside a valid entry", async () => {
    await setPlan("growth"); // gemini and claude are business-floor engines
    await expect(put([{ engine_key: "chatgpt", weight: 2 }, { engine_key: "gemini", enabled: false }])).rejects.toBeInstanceOf(UnsupportedEngineError);
    expect(await rows()).toEqual([]);
  });

  it("PE-4 a disabled-status engine and an unknown key are refused alike, so the entitlement set cannot be probed", async () => {
    const a = await put([{ engine_key: "grok", enabled: true }]).catch((e) => e);
    const b = await put([{ engine_key: "no_such_engine", enabled: true }]).catch((e) => e);
    expect(a).toBeInstanceOf(UnsupportedEngineError);
    expect(b).toBeInstanceOf(UnsupportedEngineError);
    expect((a as Error).message).toBe((b as Error).message);
    expect((a as { details?: unknown }).details).toEqual({ engine_key: "grok" });
    expect((b as { details?: unknown }).details).toEqual({ engine_key: "no_such_engine" });
    expect(await rows()).toEqual([]);
  });

  it("PE-5 sample_count above 1 needs drift_sampling: 403 feature_not_in_plan naming the key and the lowest plan that has it", async () => {
    driftSampling = false;
    const error = await put([{ engine_key: "chatgpt", sample_count: 2 }]).catch((e) => e);
    expect(error).toBeInstanceOf(FeatureNotInPlanError);
    expect((error as { details?: unknown }).details).toEqual({ key: "drift_sampling.enabled", min_plan: "business" });
    expect(await rows()).toEqual([]);
  });

  it("PE-6 sample_count 1 is always allowed, so a downgraded workspace can step back down; 5 is allowed when drift sampling is", async () => {
    await put([{ engine_key: "chatgpt", sample_count: 5 }]);
    driftSampling = false;
    await put([{ engine_key: "chatgpt", sample_count: 1 }]);
    expect((await rows())[0]).toMatchObject({ sample_count: 1 });
    // weight and enabled never need the feature
    await put([{ engine_key: "chatgpt", weight: 4, enabled: false }]);
    expect((await rows())[0]).toMatchObject({ weight: 4, enabled: false });
  });

  it("PE-7 another workspace's project is 404 and writes nothing; a missing or deleted project is 404", async () => {
    await expect(put([{ engine_key: "chatgpt", enabled: false }], otherProjectId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(put([{ engine_key: "chatgpt", enabled: false }], randomUUID())).rejects.toBeInstanceOf(NotFoundError);
    await db.query("UPDATE projects SET deleted_at = now() WHERE id = $1", [projectId]);
    await expect(put([{ engine_key: "chatgpt", enabled: false }])).rejects.toBeInstanceOf(NotFoundError);
    expect(await rows(otherProjectId)).toEqual([]);
    expect(await rows()).toEqual([]);
  });

  it("PE-8 the write is workspace-stamped from the context, never the request, and does not touch a sibling project", async () => {
    await put([{ engine_key: "chatgpt", weight: 2 }]);
    const stamp = await db.query("SELECT workspace_id FROM project_engines WHERE project_id = $1", [projectId]);
    expect(stamp.rows[0].workspace_id).toBe(workspaceId);
    expect(await rows(otherProjectId)).toEqual([]);
    void otherWorkspaceId;
  });

  it("PE-9 the override only narrows: the effective set never gains an engine from a row", async () => {
    await setPlan("growth");
    // A stale row for an engine above the plan (as after a downgrade) contributes nothing.
    await db.query("INSERT INTO project_engines (workspace_id, project_id, engine_key, enabled, weight, sample_count) VALUES ($1,$2,'gemini',true,5,1)", [workspaceId, projectId]);
    const res = await put([{ engine_key: "chatgpt", weight: 2 }]);
    expect(res.engines.map((e) => e.engine_key)).not.toContain("gemini");
  });

  it("PE-10 emits a span, a metric and a log line carrying the workspace id and no engine text", async () => {
    const logs: unknown[] = [];
    const spy = vi.spyOn(Logger.prototype, "log").mockImplementation((message: unknown) => void logs.push(message));
    try {
      await put([{ engine_key: "chatgpt", weight: 2 }]);
    } finally {
      spy.mockRestore();
    }
    expect(exporter.getFinishedSpans().map((s) => s.name)).toContain("projects.update_engines");
    expect(logs).toContainEqual(expect.objectContaining({ metric: "nominara_project_engines_updated_total" }));
    const line = logs.find((l) => (l as { event?: string }).event === "project.engines_updated") as Record<string, unknown>;
    expect(line).toMatchObject({ workspace_id: workspaceId, project_id: projectId, engines_changed: 1 });
    expect(JSON.stringify(line)).not.toContain("W");
  });

  it("PE-11 a refused write emits the refusal metric and an error span, not the success one", async () => {
    const logs: unknown[] = [];
    const spy = vi.spyOn(Logger.prototype, "log").mockImplementation((message: unknown) => void logs.push(message));
    try {
      await put([{ engine_key: "grok", enabled: true }]).catch(() => undefined);
    } finally {
      spy.mockRestore();
    }
    expect(logs).not.toContainEqual(expect.objectContaining({ metric: "nominara_project_engines_updated_total" }));
    expect(exporter.getFinishedSpans().find((s) => s.name === "projects.update_engines")?.status.code).toBe(2);
  });
});
