import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RUNTIME_ROLES, BREAKGLASS_ROLE } from "../../src/db/conventions.js";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { TopicsService } from "../../src/modules/prompts/topics.service.js";
import { withTenantContext, type TenantContext } from "../../src/tenancy/tenant-context.js";

// NEW-B-3 — TopicsService against real Postgres, as the nominara_app runtime role (RLS).
describe("NEW-B-3 · TopicsService — real SQL", () => {
  let container: StartedPostgreSqlContainer;
  let client: Client; // superuser — fixture setup and catalog seeding ONLY
  let seq = 0;

  const service = new TopicsService();

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();
  }, 120_000);

  afterAll(async () => {
    await container.stop();
  });

  beforeEach(async () => {
    client = new Client({ connectionString: container.getConnectionUri() });
    await client.connect();
    await client.query("DROP SCHEMA IF EXISTS app CASCADE");
    await client.query("DROP SCHEMA IF EXISTS _migrations CASCADE");
    await client.query("DROP SCHEMA public CASCADE");
    await client.query("CREATE SCHEMA public");
    await migrateUp(client);
    seq = 0;

    for (const role of [...RUNTIME_ROLES, BREAKGLASS_ROLE]) {
      const password = resolvePassword(role, {});
      await client.query(`ALTER ROLE ${role} PASSWORD ${client.escapeLiteral(password)}`);
    }
  });

  afterEach(async () => {
    await client.end();
  });

  // ---- helpers ----------------------------------------------------------

  async function openAppConnection(): Promise<Client> {
    const c = new Client({
      host: container.getHost(),
      port: container.getMappedPort(5432),
      database: container.getDatabase(),
      user: "nominara_app",
      password: resolvePassword("nominara_app", {}),
    });
    await c.connect();
    return c;
  }

  /** Runs `fn` inside a real tenant transaction, as `nominara_app` — the role the query actually runs as in production. */
  async function inTenant<T>(context: TenantContext, fn: () => Promise<T>): Promise<T> {
    const app = await openAppConnection();
    try {
      return await withTenantContext(app, context, fn);
    } finally {
      await app.end();
    }
  }

  async function createWorkspace(): Promise<string> {
    seq += 1;
    const result = await client.query<{ id: string }>(
      "INSERT INTO workspaces (name, slug, plan_key) VALUES ($1, $2, 'business') RETURNING id",
      [`Workspace ${seq}`, `workspace-${seq}-${randomUUID()}`],
    );
    return result.rows[0]!.id;
  }

  async function createProject(
    workspaceId: string,
    overrides: Partial<{ name: string; deletedAt: Date | null }> = {},
  ): Promise<string> {
    seq += 1;
    const { name = `Project ${seq}`, deletedAt = null } = overrides;
    const result = await client.query<{ id: string }>(
      `INSERT INTO projects (workspace_id, name, slug, root_url, root_domain, deleted_at)
       VALUES ($1, $2, $3, 'https://example.com', $4, $5)
       RETURNING id`,
      [workspaceId, name, `${name.toLowerCase().replace(/\s+/g, "-")}-${seq}`, `example-${seq}.com`, deletedAt],
    );
    return result.rows[0]!.id;
  }

  async function createTopic(workspaceId: string, projectId: string, label: string, extra = ""): Promise<string> {
    const result = await client.query<{ id: string }>(
      `INSERT INTO topic_clusters (workspace_id, project_id, label${extra === "" ? "" : ", gap_priority"})
       VALUES ($1, $2, $3${extra === "" ? "" : ", " + extra}) RETURNING id`,
      [workspaceId, projectId, label],
    );
    return result.rows[0]!.id;
  }

  const ctx = (workspaceId: string, scope?: string[]): TenantContext =>
    scope === undefined ? { workspaceId, actorId: randomUUID() } : { workspaceId, actorId: randomUUID(), scopeProjectIds: scope };

  it("NEW-B-3 AC3 — a project with no clusters returns []", async () => {
    const ws = await createWorkspace();
    const project = await createProject(ws);
    await expect(inTenant(ctx(ws), () => service.list(project))).resolves.toEqual({ topics: [] });
  });

  it("NEW-B-3 — lists only this project's topics, highest gap priority first, NULL last, null stays null", async () => {
    const ws = await createWorkspace();
    const project = await createProject(ws);
    const sibling = await createProject(ws);
    await createTopic(ws, project, "Unmeasured");
    await createTopic(ws, project, "Low", "0");
    await createTopic(ws, project, "High", "0.9");
    await createTopic(ws, sibling, "Sibling topic");
    const { topics } = await inTenant(ctx(ws), () => service.list(project));
    expect(topics.map((t) => t.label)).toEqual(["High", "Low", "Unmeasured"]);
    expect(topics[1]?.gap_priority).toBe(0);
    expect(topics[2]?.gap_priority).toBeNull();
    expect(topics[2]?.visibility_score).toBeNull();
  });

  it("STORY-047 AC11 — rename records label_source 'user' and persists", async () => {
    const ws = await createWorkspace();
    const project = await createProject(ws);
    const topic = await createTopic(ws, project, "Auto label");
    const renamed = await inTenant(ctx(ws), () => service.rename(topic, { label: "Pricing" }));
    expect(renamed.label_source).toBe("user");
    const row = await client.query("SELECT label, label_source FROM topic_clusters WHERE id = $1", [topic]);
    expect(row.rows[0]).toEqual({ label: "Pricing", label_source: "user" });
  });

  it("NEW-B-3 — a duplicate label in the same project (case-insensitive) is a 409", async () => {
    const ws = await createWorkspace();
    const project = await createProject(ws);
    await createTopic(ws, project, "Pricing");
    const other = await createTopic(ws, project, "Other");
    await expect(inTenant(ctx(ws), () => service.rename(other, { label: "pricing" }))).rejects.toMatchObject({ code: "conflict" });
  });

  it("NEW-B-3 RLS — another workspace cannot read or rename a topic; it is not found", async () => {
    const wsA = await createWorkspace();
    const wsB = await createWorkspace();
    const projectA = await createProject(wsA);
    const topic = await createTopic(wsA, projectA, "Mine");
    await expect(inTenant(ctx(wsB), () => service.rename(topic, { label: "Stolen" }))).rejects.toMatchObject({ code: "not_found" });
    await expect(inTenant(ctx(wsB), () => service.list(projectA))).rejects.toMatchObject({ code: "not_found" });
    const row = await client.query("SELECT label FROM topic_clusters WHERE id = $1", [topic]);
    expect(row.rows[0]?.label).toBe("Mine");
  });

  it("NEW-B-3 AC4 — a scoped member: in-scope rename works, out-of-scope is refused and unchanged", async () => {
    const ws = await createWorkspace();
    const inScope = await createProject(ws);
    const outScope = await createProject(ws);
    const mine = await createTopic(ws, inScope, "Mine");
    const theirs = await createTopic(ws, outScope, "Theirs");
    await expect(inTenant(ctx(ws, [inScope]), () => service.rename(mine, { label: "Renamed" }))).resolves.toMatchObject({ label: "Renamed" });
    await expect(inTenant(ctx(ws, [inScope]), () => service.rename(theirs, { label: "Renamed" }))).rejects.toThrow(/outside your assigned scope/);
    const row = await client.query("SELECT label FROM topic_clusters WHERE id = $1", [theirs]);
    expect(row.rows[0]?.label).toBe("Theirs");
  });
});
