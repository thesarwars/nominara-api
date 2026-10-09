import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { claimDueProject } from "../../src/lib/capture/scheduler.js";
import { resolveEntitlements } from "../../src/lib/entitlements/resolution.js";
import type { EntitlementResolver } from "../../src/lib/entitlements/entitlement-resolver.js";
import { PromptActivationService } from "../../src/modules/prompts/activation.service.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";

// Owner decision 2026-10-09 pm #1: confirming the prompt set in onboarding
// (POST /projects/{id}/prompts/activate) is the event that moves a project
// initializing -> active and sets next_run_at = nextRunAfter(cadence, now).
// A long-past next_run_at is re-seeded, never claimed as a burst.

describe("checkpoint-6 a-gemini · decision 2026-10-09 pm #1 · prompt confirmation activates the project", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let workspaceId: string;
  let actorId: string;

  const resolver = {
    resolveForWorkspace: async (id: string) => resolveEntitlements(db, id),
    resolve: async (id: string) => resolveEntitlements(db, id),
  } as unknown as EntitlementResolver;
  const activation = new PromptActivationService(resolver);
  const DAY_MS = 24 * 60 * 60 * 1000;

  beforeAll(async () => {
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

  beforeEach(async () => {
    await db.query("TRUNCATE tracked_prompts, projects, workspaces CASCADE");
    await db.query("TRUNCATE users CASCADE");
    actorId = (
      await db.query("INSERT INTO users (email, status) VALUES ($1, 'active') RETURNING id", [`a-${randomUUID()}@example.com`])
    ).rows[0].id;
    workspaceId = randomUUID();
    await db.query("INSERT INTO workspaces (id,name,slug,plan_key,timezone) VALUES ($1,'W',$2,'growth','UTC')", [
      workspaceId,
      `w-${randomUUID().slice(0, 8)}`,
    ]);
  });

  async function seedProject(opts: { status: string; cadence: string; nextRunAt: string | null }): Promise<{ project: string; prompt: string }> {
    const project = randomUUID();
    const prompt = randomUUID();
    await db.query(
      `INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain, status, cadence, next_run_at)
       VALUES ($1,$2,'P',$3,'https://e.test','e.test',$4,$5,${opts.nextRunAt ?? "NULL"})`,
      [project, workspaceId, `p-${randomUUID().slice(0, 8)}`, opts.status, opts.cadence],
    );
    await db.query(
      `INSERT INTO tracked_prompts (id, workspace_id, project_id, text, text_hash, intent_archetype, funnel_stage, is_priority, status)
       VALUES ($1,$2,$3,'best crm',sha256('best crm'::bytea),'recommendation','consideration',false,'archived')`,
      [prompt, workspaceId, project],
    );
    return { project, prompt };
  }

  async function activate(project: string, prompt: string): Promise<void> {
    const c = new Client({ connectionString: container.getConnectionUri() });
    await c.connect();
    await c.query("SET ROLE nominara_app");
    try {
      await withTenantContext(c, { workspaceId, actorId }, () => activation.activate(project, { prompt_ids: [prompt] }));
    } finally {
      await c.end();
    }
  }

  async function read(project: string) {
    return (await db.query<{ status: string; next_run_at: Date | null }>("SELECT status, next_run_at FROM projects WHERE id = $1", [project])).rows[0]!;
  }

  it("CP6 a-gemini · confirming the prompt set moves an initializing project to active with next_run_at = the next cadence slot", async () => {
    const { project, prompt } = await seedProject({ status: "initializing", cadence: "twice_weekly", nextRunAt: null });
    const before = Date.now();
    await activate(project, prompt);
    const after = Date.now();
    const row = await read(project);

    expect(row.status).toBe("active");
    const interval = (30 * DAY_MS) / 8;
    expect(row.next_run_at!.getTime()).toBeGreaterThanOrEqual(before + interval);
    expect(row.next_run_at!.getTime()).toBeLessThanOrEqual(after + interval);
  });

  it("CP6 a-gemini · a long-past next_run_at gets a fresh slot, never an immediate burst", async () => {
    const { project, prompt } = await seedProject({ status: "initializing", cadence: "weekly", nextRunAt: "now() - interval '40 days'" });
    await activate(project, prompt);
    const row = await read(project);

    expect(row.status).toBe("active");
    expect(row.next_run_at!.getTime()).toBeGreaterThan(Date.now());
    expect(await claimDueProject(db, project, new Date())).toBeNull();
  });

  it("CP6 a-gemini · a manual-cadence project activates with next_run_at NULL (null stays null)", async () => {
    const { project, prompt } = await seedProject({ status: "initializing", cadence: "manual", nextRunAt: null });
    await activate(project, prompt);
    const row = await read(project);

    expect(row.status).toBe("active");
    expect(row.next_run_at).toBeNull();
  });

  it("CP6 a-gemini · activating prompts on a paused project does not reactivate it or move its next_run_at", async () => {
    const { project, prompt } = await seedProject({ status: "paused", cadence: "weekly", nextRunAt: "now() + interval '2 days'" });
    const beforeRow = await read(project);
    await activate(project, prompt);
    const row = await read(project);

    expect(row.status).toBe("paused");
    expect(row.next_run_at!.getTime()).toBe(beforeRow.next_run_at!.getTime());
  });

  it("CP6 a-gemini · activating more prompts on an already-active project leaves next_run_at where it is", async () => {
    const { project, prompt } = await seedProject({ status: "active", cadence: "weekly", nextRunAt: "now() + interval '2 days'" });
    const beforeRow = await read(project);
    await activate(project, prompt);
    const row = await read(project);

    expect(row.status).toBe("active");
    expect(row.next_run_at!.getTime()).toBe(beforeRow.next_run_at!.getTime());
  });
});
