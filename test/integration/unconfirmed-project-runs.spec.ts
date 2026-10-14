import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { Redis } from "ioredis";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { InMemoryCacheAdapter } from "../../src/lib/cache/in-memory-cache.adapter.js";
import { dispatchPlannedRun, planRun, type PlanRunContext } from "../../src/lib/capture/plan-run.js";
import { createQueueWorkerConnection, queueKeyPrefix } from "../../src/lib/queue/connection.js";
import { buildQueue } from "../../src/lib/queue/queue-factory.js";
import { QUEUE_TOPOLOGY } from "../../src/lib/queue/topology.js";
import { resolveEntitlements } from "../../src/lib/entitlements/resolution.js";
import type { EntitlementResolver } from "../../src/lib/entitlements/entitlement-resolver.js";
import { PromptActivationService } from "../../src/modules/prompts/activation.service.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";
import { startValkeyFixture, type ValkeyFixture } from "../support/valkey-fixture.js";

// STORY-044 AC6 / scenario 8 — "Confirmation is not required to use the
// project. A project with unconfirmed low-confidence fields is fully
// functional; the flag is a prompt, not a gate."
//
// The criterion was true by absence (no code reads discovery_status on these
// paths) and nothing asserted it. This drives the real activation service and
// the real planner/dispatcher against a project that has NEVER been confirmed
// and whose discovered fields are all below the 0.60 threshold.

const ENTRY = QUEUE_TOPOLOGY.find((entry) => entry.name === "capture.plan")!;
const PERIOD = "2026-08-01";
const NOW_MS = Date.UTC(2026, 7, 20, 12, 0, 0);

describe("STORY-044 · scenario 8 · an unconfirmed project is fully functional", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let valkey: ValkeyFixture;
  let workspaceId: string;
  let actorId: string;
  let projectId: string;
  let promptId: string;
  const connections: Redis[] = [];
  const cleanups: (() => Promise<void>)[] = [];

  const resolver = {
    resolveForWorkspace: async (id: string) => resolveEntitlements(db, id),
    resolve: async (id: string) => resolveEntitlements(db, id),
  } as unknown as EntitlementResolver;
  const activation = new PromptActivationService(resolver);

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await migrateUp(db);
    valkey = await startValkeyFixture();
  }, 300_000);

  afterEach(async () => {
    for (const fn of cleanups.splice(0)) await fn();
    for (const connection of connections.splice(0)) await connection.quit().catch(() => undefined);
  });

  afterAll(async () => {
    await valkey.stop();
    await db.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.query(
      "TRUNCATE answer_captures, tracked_prompts, project_engines, capture_runs, projects, usage_counters, workspaces, engines CASCADE",
    );
    await db.query("TRUNCATE users CASCADE");
    actorId = (
      await db.query("INSERT INTO users (email, status) VALUES ($1, 'active') RETURNING id", [`a-${randomUUID()}@example.com`])
    ).rows[0].id;
    workspaceId = randomUUID();
    projectId = randomUUID();
    promptId = randomUUID();
    await db.query("INSERT INTO workspaces (id, name, slug, plan_key, timezone) VALUES ($1, 'W', $2, 'growth', 'UTC')", [
      workspaceId,
      `w-${randomUUID().slice(0, 8)}`,
    ]);
    // Discovery COMPLETED, every field below 0.60, none edited, nothing confirmed.
    const discovery = {
      fields: {
        category: { value: "crm", confidence: 0.31, source: "inferred" },
        brand_name: { value: "Acme", confidence: 0.42, source: "inferred" },
      },
      low_confidence_fields: ["category", "brand_name"],
    };
    await db.query(
      `INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain, status, cadence,
                             discovery, discovery_status)
       VALUES ($1, $2, 'P', $3, 'https://e.test', 'e.test', 'initializing', 'weekly', $4::jsonb, 'completed')`,
      [projectId, workspaceId, `p-${randomUUID().slice(0, 8)}`, JSON.stringify(discovery)],
    );
    await db.query(
      `INSERT INTO tracked_prompts (id, workspace_id, project_id, text, text_hash, intent_archetype, funnel_stage, is_priority, status)
       VALUES ($1,$2,$3,'best crm',sha256('best crm'::bytea),'recommendation','consideration',false,'archived')`,
      [promptId, workspaceId, projectId],
    );
    await db.query(
      `INSERT INTO engines (key, display_name, vendor, capture_mode, adapter_version,
                            cache_ttl_seconds, volatility_band, min_plan_key, status)
       VALUES ('perplexity','perplexity','v','api','1.0.0',86400,'medium','free','active')`,
    );
    await db.query(
      `INSERT INTO project_engines (workspace_id, project_id, engine_key, enabled, sample_count)
       VALUES ($1, $2, 'perplexity', true, 1)`,
      [workspaceId, projectId],
    );
  });

  async function activate(): Promise<void> {
    const c = new Client({ connectionString: container.getConnectionUri() });
    await c.connect();
    await c.query("SET ROLE nominara_app");
    try {
      await withTenantContext(c, { workspaceId, actorId }, () => activation.activate(projectId, { prompt_ids: [promptId] }));
    } finally {
      await c.end();
    }
  }

  it("STORY-044 scenario 8 · prompts activate and a run is planned and dispatched without any confirmation", async () => {
    // The precondition that makes the rest mean something.
    const before = (await db.query("SELECT discovery, discovery_status FROM projects WHERE id = $1", [projectId])).rows[0];
    expect(before.discovery_status).toBe("completed");
    expect(before.discovery.low_confidence_fields).toEqual(["category", "brand_name"]);
    expect(JSON.stringify(before.discovery)).not.toContain("user_edited");

    await activate();

    const project = (await db.query("SELECT status, next_run_at FROM projects WHERE id = $1", [projectId])).rows[0];
    expect(project.status).toBe("active");
    expect(project.next_run_at).not.toBeNull();
    const prompt = (await db.query("SELECT status FROM tracked_prompts WHERE id = $1", [promptId])).rows[0];
    expect(prompt.status).toBe("active");

    const runId = randomUUID();
    await db.query(
      `INSERT INTO capture_runs (id, workspace_id, project_id, trigger, engine_keys)
       VALUES ($1, $2, $3, 'scheduled', ARRAY['perplexity'])`,
      [runId, workspaceId, projectId],
    );
    const ctx: PlanRunContext = {
      workspaceId,
      projectId,
      runId,
      trigger: "scheduled",
      cadence: "weekly",
      planKey: "growth",
      scope: "all",
      periodStart: PERIOD,
      locale: "en-US",
      personaHint: null,
      normalizerVersion: "v1",
      captureMode: "api",
      captureReadyEngineKeys: ["perplexity"],
      env: "test",
      sharedCacheEnabled: true,
      nowMs: NOW_MS,
    };
    await db.query("BEGIN");
    const plan = await planRun(db, new InMemoryCacheAdapter(), ctx);
    await db.query("COMMIT");

    expect(plan.planned).toBe(1);
    expect(plan.live).toBe(1);

    const connection = createQueueWorkerConnection(valkey.connectionString);
    connections.push(connection);
    const queue = buildQueue(ENTRY, { connection, prefix: queueKeyPrefix(`unconfirmed-${randomUUID().slice(0, 8)}`) });
    cleanups.push(async () => {
      await queue.obliterate({ force: true }).catch(() => undefined);
      await queue.close();
    });
    await dispatchPlannedRun(queue, ENTRY, plan);
    expect(await queue.getJobCountByTypes("waiting", "delayed", "prioritized", "active")).toBe(1);

    // Still unconfirmed afterwards: using the project did not require, or perform, a confirmation.
    const after = (await db.query("SELECT discovery FROM projects WHERE id = $1", [projectId])).rows[0];
    expect(after.discovery).toEqual(before.discovery);
  }, 120_000);
});
