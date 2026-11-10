import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { Job } from "bullmq";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { createCrawlDiscoverHandler } from "../../src/lib/queue/handlers/crawl-discover.handler.js";
import { phasesOf, type TenantStep } from "../../src/lib/queue/worker-factory.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";
import type { TextEmbedder } from "../../src/lib/categories/classify.js";
import { ProjectsService } from "../../src/modules/projects/projects.service.js";

// STORY-195 AC6 against real Postgres: while the category classification (a provider call) is still pending, the project's discovery READ,
// from a different connection, already shows the document fields with their confidence; and a finished payload is never overwritten.

const PAGE = `<!doctype html><html lang="en-US"><head><title>Acme CRM | Sell more</title>
<meta name="description" content="Pipeline and contact management for sales teams."></head><body><h1>Close deals faster</h1></body></html>`;

describe("STORY-195 · discovery fields are visible as they are found", () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let workspaceId: string;
  let projectId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18").withDatabase("nominara_test").withUsername("nominara").withPassword("nominara").start();
    pool = new Pool({ connectionString: container.getConnectionUri(), max: 6 });
    const admin = await pool.connect();
    try {
      await migrateUp(admin);
    } finally {
      admin.release();
    }
  }, 300_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE projects, workspaces CASCADE");
    workspaceId = randomUUID();
    projectId = randomUUID();
    await pool.query("INSERT INTO workspaces (id, name, slug, plan_key) VALUES ($1, 'W', $2, 'growth')", [workspaceId, `w-${randomUUID().slice(0, 8)}`]);
    await pool.query(
      `INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain, discovery_status) VALUES ($1, $2, 'acme.example', $3, 'https://acme.example', 'acme.example', 'pending')`,
      [projectId, workspaceId, `p-${randomUUID().slice(0, 8)}`],
    );
  });

  const job = (): Job => ({ data: { payload: { workspaceId, kid: "k", projectId, rootUrl: "https://acme.example", fieldsSupplied: [] } } }) as unknown as Job;
  const step: TenantStep = async (fn) => {
    const client = await pool.connect();
    try {
      return await withTenantContext(client, { workspaceId, actorId: randomUUID() }, fn);
    } finally {
      client.release();
    }
  };
  const inTenant = step;

  async function readDiscovery(): Promise<{ discovery_status: string; fields: Record<string, { confidence: number; source: string }> }> {
    const row = await pool.query<{ discovery: never; discovery_status: string }>("SELECT discovery, discovery_status FROM projects WHERE id = $1", [projectId]);
    return { discovery_status: row.rows[0]!.discovery_status, fields: (row.rows[0]!.discovery as { fields?: never }).fields ?? {} };
  }

  it("STORY-195-AC6 the document fields are readable with their confidence while the category is still being classified", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const embedder: TextEmbedder = {
      model: "streaming-spec",
      embed: vi.fn(async (texts: readonly string[]) => {
        // The first call is the category vectors; hold the site text's call until the assertions have run.
        if (texts.length === 1) await gate;
        return { vectors: texts.map(() => [1, 0]), totalTokens: texts.length };
      }),
    };
    const deps = { fetch: vi.fn(async () => ({ status: 200, headers: {}, body: Buffer.from(PAGE), finalUrl: "https://acme.example/" })), now: () => Date.now() };
    const phases = phasesOf(createCrawlDiscoverHandler({ pool: {} as never, env: {} as never }, deps, embedder))!;

    const prepared = await inTenant((tx) => phases.prepare(tx, job()));
    const running = phases.run(prepared as never, job(), step);

    await vi.waitFor(async () => {
      const seen = await readDiscovery();
      expect(seen.discovery_status).toBe("running");
      expect(Object.keys(seen.fields)).toEqual(expect.arrayContaining(["brand_name", "description"]));
      expect(seen.fields.brand_name!.confidence).toBeGreaterThan(0);
      expect(seen.fields.category).toBeUndefined();
    });
    release();
    await running;
  });

  it("STORY-195-AC6 GET /discovery (discoveryFor) returns the checkpointed fields mid-run", async () => {
    const deps = { fetch: vi.fn(async () => ({ status: 200, headers: {}, body: Buffer.from(PAGE), finalUrl: "https://acme.example/" })), now: () => Date.now() };
    const phases = phasesOf(createCrawlDiscoverHandler({ pool: {} as never, env: {} as never }, deps))!;
    const prepared = await inTenant((tx) => phases.prepare(tx, job()));
    await phases.run(prepared as never, job(), step);
    // No commit: the pass has not finished, yet the read already has what was found.
    const read = await inTenant(async () => new ProjectsService(undefined as never, undefined as never, undefined as never).discoveryFor(projectId));
    expect(read.discovery_status).toBe("running");
    expect(read.fields.brand_name).toBeDefined();
  });

  it("STORY-195-AC6 a checkpoint cannot overwrite a finished payload", async () => {
    const finished = { discovery_status: "completed", duration_ms: 9, fields: { brand_name: { value: "Final", confidence: 0.9, source: "x", user_edited: false } }, competitors_proposed: [], prompts_generated: [], prompts_free_remaining: 10, credits_charged: 0, low_confidence_fields: [] };
    await pool.query("UPDATE projects SET discovery = $2, discovery_status = 'completed' WHERE id = $1", [projectId, JSON.stringify(finished)]);
    const deps = { fetch: vi.fn(async () => ({ status: 200, headers: {}, body: Buffer.from(PAGE), finalUrl: "https://acme.example/" })), now: () => Date.now() };
    const phases = phasesOf(createCrawlDiscoverHandler({ pool: {} as never, env: {} as never }, deps))!;
    // `prepare` would mark the project running; a delivery that lost the race meets a project that already completed.
    const prepared = { payload: { projectId, rootUrl: "https://acme.example", fieldsSupplied: [], workspaceId, kid: "k" }, rootDomain: "acme.example", submittedAt: null, knownBrandNames: [], humanDecided: [], preserved: {}, stored: finished, categories: [], currentCategory: null };
    await phases.run(prepared as never, job(), step);
    const after = await readDiscovery();
    expect(after.discovery_status).toBe("completed");
    expect(after.fields.brand_name!.source).toBe("x");
  });

  it("STORY-195-AC6 a deleted project is not written by a checkpoint", async () => {
    await pool.query("UPDATE projects SET deleted_at = now(), discovery_status = 'running' WHERE id = $1", [projectId]);
    const deps = { fetch: vi.fn(async () => ({ status: 200, headers: {}, body: Buffer.from(PAGE), finalUrl: "https://acme.example/" })), now: () => Date.now() };
    const phases = phasesOf(createCrawlDiscoverHandler({ pool: {} as never, env: {} as never }, deps))!;
    const prepared = { payload: { projectId, rootUrl: "https://acme.example", fieldsSupplied: [], workspaceId, kid: "k" }, rootDomain: "acme.example", submittedAt: null, knownBrandNames: [], humanDecided: [], preserved: {}, stored: {}, categories: [], currentCategory: null };
    await phases.run(prepared as never, job(), step);
    expect((await readDiscovery()).fields).toEqual({});
  });
});
