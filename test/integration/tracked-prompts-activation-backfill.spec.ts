import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, migrateUp } from "../../src/db/migrate-runner.js";

// STORY-046 AC3 - migration 0124 on a POPULATED database. Every customer who exists before the charge ships activated
// their prompts under the old rule (free), so the backfill must stamp every prompt that is known to have run as
// activated-and-free; otherwise re-activating one is charged as a first activation, or hands out a second free ten.
//
// "Known to have run" is: not archived today, OR archived but with evidence of having run (an answer_captures row).
// An archived prompt with no such evidence is genuinely a never-activated candidate and stays NULL: guessing "yes"
// gives credits away, guessing "no" for one that ran charges a customer for a prompt they already had.

describe("STORY-046 AC3 - migration 0124 backfills the activation fact on existing data", () => {
  let container: StartedPostgreSqlContainer;
  let client: Client;
  let baselineDir: string;
  const workspaceId = randomUUID();
  const projectId = randomUUID();

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();
    client = new Client({ connectionString: container.getConnectionUri() });
    await client.connect();
    baselineDir = await mkdtemp(path.join(tmpdir(), "nominara-0124-"));
    for (const entry of await readdir(MIGRATIONS_DIR)) {
      if (entry.slice(0, 4) < "0124") await copyFile(path.join(MIGRATIONS_DIR, entry), path.join(baselineDir, entry));
    }
    await migrateUp(client, baselineDir);
  }, 300_000);

  afterAll(async () => {
    await client?.end();
    await container?.stop();
    if (baselineDir) await rm(baselineDir, { recursive: true, force: true });
  });

  async function prompt(status: string, source: string, options: { captured?: boolean; deleted?: boolean } = {}): Promise<string> {
    const id = randomUUID();
    await client.query(
      `INSERT INTO tracked_prompts (id, workspace_id, project_id, text, text_hash, intent_archetype, funnel_stage, status, generation_source)
       VALUES ($1,$2,$3,$4::text,sha256(convert_to($4::text,'UTF8')),'recommendation','consideration',$5,$6)`,
      [id, workspaceId, projectId, `p ${id}`, status, source],
    );
    if (options.deleted === true) await client.query("UPDATE tracked_prompts SET deleted_at = now() WHERE id = $1", [id]);
    if (options.captured === true) {
      await client.query(
        `INSERT INTO answer_captures (workspace_id, project_id, run_id, prompt_id, engine_key, captured_at, capture_mode,
                                      adapter_version, normalizer_version, content_hash, status)
         VALUES ($1,$2,$3,$4,'gemini', now(), 'api','1.0.0','n1',$5,'parsed')`,
        [workspaceId, projectId, randomUUID(), id, createHash("sha256").update(id).digest()],
      );
    }
    return id;
  }

  const ids: Record<string, string> = {};

  beforeAll(async () => {
    await client.query(`INSERT INTO plans (key, display_name, monthly_price, annual_price, entitlements) VALUES ('free','Free',0,0,'{}') ON CONFLICT (key) DO NOTHING`);
    await client.query(`INSERT INTO workspaces (id, name, slug, plan_key) VALUES ($1,'W',$2,'free')`, [workspaceId, `w-${workspaceId.slice(0, 8)}`]);
    await client.query(
      `INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain) VALUES ($1,$2,'P','p','https://e.test','e.test')`,
      [projectId, workspaceId],
    );
    ids.active = await prompt("active", "generated");
    ids.paused = await prompt("paused", "generated");
    ids.archivedRan = await prompt("archived", "generated", { captured: true });
    ids.archivedRanDeleted = await prompt("archived", "generated", { captured: true, deleted: true });
    ids.archivedNeverRan = await prompt("archived", "generated");
    ids.archivedManualRan = await prompt("archived", "manual", { captured: true });
    ids.activeManual = await prompt("active", "manual");
    await migrateUp(client);
  }, 300_000);

  async function fact(key: string): Promise<{ stamped: boolean; credits: number; atCreated: boolean }> {
    const row = (
      await client.query(
        `SELECT first_activated_at IS NOT NULL AS stamped, activation_credits::int AS credits, first_activated_at = created_at AS at_created
           FROM tracked_prompts WHERE id = $1`,
        [ids[key]],
      )
    ).rows[0];
    return { stamped: row.stamped, credits: row.credits, atCreated: row.at_created === true };
  }

  it("a generated prompt that is active or paused today is stamped activated-and-free", async () => {
    expect(await fact("active")).toEqual({ stamped: true, credits: 0, atCreated: true });
    expect(await fact("paused")).toEqual({ stamped: true, credits: 0, atCreated: true });
  });

  it("an ARCHIVED generated prompt with evidence of having run (a capture) is stamped activated-and-free too", async () => {
    expect(await fact("archivedRan")).toEqual({ stamped: true, credits: 0, atCreated: true });
  });

  it("evidence counts even when the prompt has since been soft-deleted: the free ten must not be handed back", async () => {
    expect((await fact("archivedRanDeleted")).stamped).toBe(true);
  });

  it("an archived generated prompt with NO evidence of having run stays a never-activated candidate", async () => {
    expect((await fact("archivedNeverRan")).stamped).toBe(false);
  });

  it("manual prompts are never stamped, with or without evidence: they are never charged and never spend the allowance", async () => {
    expect((await fact("archivedManualRan")).stamped).toBe(false);
    expect((await fact("activeManual")).stamped).toBe(false);
  });
});
