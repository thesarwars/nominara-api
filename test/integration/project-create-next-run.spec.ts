import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { claimDueProject, nextRunAfter } from "../../src/lib/capture/scheduler.js";
import type { EntitlementResolver } from "../../src/lib/entitlements/entitlement-resolver.js";
import type { UrlGuard } from "../../src/lib/net/url-guard.service.js";
import type { QueueProducer } from "../../src/lib/queue/queue-producer.js";
import { ProjectsService } from "../../src/modules/projects/projects.service.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";

// Owner decision 2026-10-09 #2 (checkpoint-5 lane a-gemini): a project created
// with a cadence other than `manual` gets next_run_at = the next cadence slot,
// so the scheduler sweep has something to claim. Executed against real
// migrations through ProjectsService.create, not asserted on SQL text.

describe("checkpoint-5 a-gemini · decision 2026-10-09 #2 · create seeds next_run_at", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let workspaceId: string;
  let actorId: string;

  const resolver = {
    resolveForWorkspace: async () => ({ entitlements: {} }),
    resolve: async () => ({ entitlements: {} }),
  } as unknown as EntitlementResolver;
  const queues = { enqueueTenantJob: async () => ({}) } as unknown as QueueProducer;
  const urls = { validateAndNormalize: async () => ({ rootDomain: "hubspot.com" }) } as unknown as UrlGuard;
  const projects = new ProjectsService(queues, resolver, urls);

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
    await db.query("TRUNCATE milestones, competitors, projects, workspaces CASCADE");
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

  async function create(): Promise<string> {
    const c = new Client({ connectionString: container.getConnectionUri() });
    await c.connect();
    await c.query("SET ROLE nominara_app");
    try {
      const out = await withTenantContext(c, { workspaceId, actorId }, () =>
        projects.create(workspaceId, actorId, { root_url: "https://hubspot.com" }, undefined),
      );
      return out.project_id;
    } finally {
      await c.end();
    }
  }

  it("CP5 a-gemini · a project created with the default (non-manual) cadence gets next_run_at = the next cadence slot", async () => {
    const before = new Date();
    const id = await create();
    const after = new Date();
    const row = (await db.query<{ cadence: string; next_run_at: Date | null }>("SELECT cadence, next_run_at FROM projects WHERE id = $1", [id])).rows[0]!;

    expect(row.cadence).not.toBe("manual");
    expect(row.next_run_at).not.toBeNull();
    const lo = nextRunAfter(row.cadence as "weekly", before)!.getTime();
    const hi = nextRunAfter(row.cadence as "weekly", after)!.getTime();
    expect(row.next_run_at!.getTime()).toBeGreaterThanOrEqual(lo);
    expect(row.next_run_at!.getTime()).toBeLessThanOrEqual(hi);
  });

  it("CP5 a-gemini · the seeded project is claimable once active and its slot has passed, and not before", async () => {
    const id = await create();
    await db.query("UPDATE projects SET status = 'active' WHERE id = $1", [id]);
    const slot = (await db.query<{ next_run_at: Date }>("SELECT next_run_at FROM projects WHERE id = $1", [id])).rows[0]!.next_run_at;

    expect(await claimDueProject(db, id, new Date(slot.getTime() - 1000))).toBeNull();
    expect((await claimDueProject(db, id, new Date(slot.getTime() + 1000)))?.projectId).toBe(id);
  });
});
