import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { EntitlementExceededError } from "../../src/api/errors/domain-errors.js";
import type { EntitlementResolver } from "../../src/lib/entitlements/entitlement-resolver.js";
import type { QueueProducer } from "../../src/lib/queue/queue-producer.js";
import type { UrlGuard } from "../../src/lib/net/url-guard.service.js";
import { CompetitorTrackingService } from "../../src/modules/projects/competitor-tracking.service.js";
import { ProjectsService } from "../../src/modules/projects/projects.service.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";

// CP1 re-audit (c-comp MAJOR) — the competitor cap has TWO writers: the
// track endpoint (NEW-C-2) and the discovery confirm (STORY-044 AC5). Both
// read the live count and then insert, so under READ COMMITTED both must take
// the same per-project advisory lock or a track and a confirm at the cap each
// see "room for one" and leave the project over it.

describe("CP1 c-comp · the competitor cap holds across track AND discovery confirm", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let workspaceId: string;
  let projectId: string;
  let actorId: string;
  let cap = 5;

  const resolver = {
    resolveForWorkspace: async () => ({ entitlements: { "competitors.max_per_project": { value: cap } } }),
    resolve: async () => ({ entitlements: { "competitors.max_per_project": { value: cap } } }),
  } as unknown as EntitlementResolver;
  const queues = { enqueueTenantJob: async () => ({}) } as unknown as QueueProducer;
  const tracking = new CompetitorTrackingService(queues, resolver);
  const projects = new ProjectsService(queues, resolver, {} as unknown as UrlGuard);

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
    cap = 5;
    actorId = (
      await db.query("INSERT INTO users (email, status) VALUES ($1, 'active') RETURNING id", [`a-${randomUUID()}@example.com`])
    ).rows[0].id;
    workspaceId = randomUUID();
    projectId = randomUUID();
    await db.query("INSERT INTO workspaces (id,name,slug,plan_key,timezone) VALUES ($1,'W',$2,'growth','UTC')", [
      workspaceId,
      `w-${randomUUID().slice(0, 8)}`,
    ]);
    await db.query(
      `INSERT INTO projects (id,workspace_id,name,slug,root_url,root_domain) VALUES ($1,$2,'p',$3,'https://hubspot.com','hubspot.com')`,
      [projectId, workspaceId, `p-${randomUUID().slice(0, 8)}`],
    );
  });

  async function appClients(n: number): Promise<Client[]> {
    const clients: Client[] = [];
    for (let i = 0; i < n; i += 1) {
      const c = new Client({ connectionString: container.getConnectionUri() });
      await c.connect();
      await c.query("SET ROLE nominara_app");
      clients.push(c);
    }
    return clients;
  }
  const trackOn = (c: Client, name: string) =>
    withTenantContext(c, { workspaceId, actorId }, () => tracking.track(workspaceId, actorId, projectId, { name }));
  const confirmOn = (c: Client, name: string) =>
    withTenantContext(c, { workspaceId, actorId }, () =>
      projects.confirmDiscovery(workspaceId, projectId, { competitors: [{ name }] }, undefined),
    );
  const liveCount = async () =>
    (await db.query("SELECT count(*)::int AS n FROM competitors WHERE project_id=$1 AND deleted_at IS NULL", [projectId])).rows[0].n;

  it("STORY-044 AC5 — a discovery confirm with competitors actually writes the rows (source 'user')", async () => {
    const [c] = await appClients(1);
    try {
      await confirmOn(c!, "Salesforce");
      const rows = await db.query("SELECT name, source FROM competitors WHERE project_id=$1", [projectId]);
      expect(rows.rows).toEqual([{ name: "Salesforce", source: "user" }]);
    } finally {
      await c!.end();
    }
  });

  it("CP1 c-comp MAJOR — 10 tracks and 10 confirms of different names under the app role never exceed the cap", async () => {
    cap = 4;
    const clients = await appClients(20);
    try {
      const work = clients.map((c, i) => (i % 2 === 0 ? trackOn(c, `Track ${String(i)}`) : confirmOn(c, `Confirm ${String(i)}`)));
      const results = await Promise.allSettled(work);
      for (const r of results) {
        if (r.status === "rejected") expect(r.reason).toBeInstanceOf(EntitlementExceededError);
      }
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(4);
      expect(await liveCount()).toBe(4);
    } finally {
      await Promise.all(clients.map((c) => c.end()));
    }
  });
});
