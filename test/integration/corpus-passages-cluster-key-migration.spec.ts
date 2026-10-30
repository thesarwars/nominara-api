import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, migrateUp } from "../../src/db/migrate-runner.js";

// Migration 0151 - STORY-059 AC1 (owner decision 11): the corpus_passages key gains project_id and prompt_cluster_id (new unique
// index first, old one dropped after), and semantic_nodes gains embedding_model (owner decision 2026-10-28 #4).

const NAME = "0151_corpus_passages_cluster_key";

describe("migration 0151 - corpus_passages cluster key and semantic_nodes.embedding_model", () => {
  let container: StartedPostgreSqlContainer;
  let client: Client;
  let baselineDir: string;
  const workspaceId = randomUUID();
  const [projectA, projectB] = [randomUUID(), randomUUID()];
  const [clusterA, clusterB] = [randomUUID(), randomUUID()];
  const hashOf = (text: string): Buffer => createHash("sha256").update(text).digest();

  const insertPassage = (project: string, cluster: string | null, text: string, model = "model-a", createdAt = "now()") =>
    client.query(
      `INSERT INTO corpus_passages
         (workspace_id, project_id, prompt_cluster_id, citation_url_hash, url, domain, passage_index, text, token_count,
          content_hash, embedding_model, expires_at, created_at)
       VALUES ($1, $2, $3, $4, 'https://example.com', 'example.com', 0, $5, 10, $6, $7, now() + interval '30 days', ${createdAt})`,
      [workspaceId, project, cluster, hashOf("url"), text, hashOf(text), model],
    );
  const indexNames = async (): Promise<string[]> =>
    (await client.query<{ indexname: string }>("SELECT indexname FROM pg_indexes WHERE tablename = 'corpus_passages' AND indexname LIKE 'ux_corpus_passages%' ORDER BY 1")).rows.map((r) => r.indexname);

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18").withDatabase("nominara_test").withUsername("nominara").withPassword("nominara").start();
    client = new Client({ connectionString: container.getConnectionUri() });
    await client.connect();
    baselineDir = await mkdtemp(path.join(tmpdir(), "nominara-0151-"));
    for (const entry of await readdir(MIGRATIONS_DIR)) {
      if (entry.slice(0, 4) < "0151") await copyFile(path.join(MIGRATIONS_DIR, entry), path.join(baselineDir, entry));
    }
    await migrateUp(client, baselineDir);
    await client.query(`INSERT INTO plans (key, display_name, monthly_price, annual_price, entitlements) VALUES ('free','Free',0,0,'{}') ON CONFLICT (key) DO NOTHING`);
    await client.query(`INSERT INTO workspaces (id, name, slug, plan_key) VALUES ($1,'W',$2,'free')`, [workspaceId, `w-${workspaceId.slice(0, 8)}`]);
    for (const project of [projectA, projectB]) {
      await client.query(`INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain) VALUES ($1,$2,'P',$3,'https://example.com','example.com')`, [project, workspaceId, `p-${project.slice(0, 8)}`]);
    }
    await insertPassage(projectA, clusterA, "populated-before");
  }, 300_000);

  afterAll(async () => {
    await client?.end();
    await container?.stop();
    if (baselineDir) await rm(baselineDir, { recursive: true, force: true });
  });

  it("AC1 - before: the old key blocks a second cluster holding the same text (the hazard this migration removes)", async () => {
    expect(await indexNames()).toEqual(["ux_corpus_passages"]);
    await expect(insertPassage(projectA, clusterB, "populated-before")).rejects.toThrow(/ux_corpus_passages/);
  });

  it("AC1 - up on a POPULATED table keeps every row, and the new index exists before the old one is gone (one transaction, new first)", async () => {
    const up = await readFile(path.join(MIGRATIONS_DIR, `${NAME}.up.sql`), "utf8");
    const create = up.indexOf("CREATE UNIQUE INDEX IF NOT EXISTS ux_corpus_passages_cluster");
    const drop = up.indexOf("DROP INDEX IF EXISTS ux_corpus_passages;");
    expect(create).toBeGreaterThan(-1);
    expect(drop).toBeGreaterThan(create);
    await migrateUp(client);
    expect((await client.query("SELECT count(*)::int AS n FROM corpus_passages")).rows[0]).toEqual({ n: 1 });
    expect(await indexNames()).toEqual(["ux_corpus_passages_cluster"]);
  });

  it("AC1 - after: another cluster, another project and another model hold the same text; the same (project, cluster, text, model) does not; a NULL cluster is one slot", async () => {
    await expect(insertPassage(projectA, clusterB, "populated-before")).resolves.toBeDefined();
    await expect(insertPassage(projectB, clusterA, "populated-before")).resolves.toBeDefined();
    await expect(insertPassage(projectA, clusterA, "populated-before", "model-b")).resolves.toBeDefined();
    await expect(insertPassage(projectA, clusterA, "populated-before")).rejects.toThrow(/ux_corpus_passages_cluster/);
    await expect(insertPassage(projectA, null, "null-cluster")).resolves.toBeDefined();
    await expect(insertPassage(projectA, null, "null-cluster")).rejects.toThrow(/ux_corpus_passages_cluster/);
    const def = (await client.query<{ indexdef: string }>("SELECT indexdef FROM pg_indexes WHERE indexname = 'ux_corpus_passages_cluster'")).rows[0]!.indexdef;
    expect(def).toMatch(/workspace_id, project_id, prompt_cluster_id, content_hash, embedding_model/);
  });

  it("owner decision 4 - semantic_nodes.embedding_model exists, nullable, with no default", async () => {
    const col = (await client.query("SELECT is_nullable, column_default, data_type FROM information_schema.columns WHERE table_name = 'semantic_nodes' AND column_name = 'embedding_model'")).rows[0];
    expect(col).toEqual({ is_nullable: "YES", column_default: null, data_type: "text" });
  });

  it("down restores the narrow key by keeping the earliest copy of each text, drops the column; up again restores the wide key", async () => {
    const down = await readFile(path.join(MIGRATIONS_DIR, `${NAME}.down.sql`), "utf8");
    await client.query(down);
    expect(await indexNames()).toEqual(["ux_corpus_passages"]);
    const left = (await client.query<{ n: number }>("SELECT count(*)::int AS n FROM corpus_passages WHERE content_hash = $1 AND embedding_model = 'model-a'", [hashOf("populated-before")])).rows[0]!.n;
    expect(left).toBe(1);
    expect((await client.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'semantic_nodes' AND column_name = 'embedding_model'")).rowCount).toBe(0);
    await expect(insertPassage(projectB, clusterB, "populated-before")).rejects.toThrow(/ux_corpus_passages/);
    await client.query(await readFile(path.join(MIGRATIONS_DIR, `${NAME}.up.sql`), "utf8"));
    expect(await indexNames()).toEqual(["ux_corpus_passages_cluster"]);
  });
});
