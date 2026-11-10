import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { Job } from "bullmq";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PromptGeneration } from "../../contracts/prompts/index.js";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { generateFreeAllowance } from "../../src/lib/discovery/free-prompts.js";
import { signQueueJobPayload } from "../../src/lib/queue/envelope.js";
import { createPromptGenerateHandler, type PromptGenerateDeps } from "../../src/lib/queue/handlers/prompt-generate.handler.js";
import type { QueueHandlerContext } from "../../src/lib/queue/handlers.js";
import { QUEUE_TOPOLOGY } from "../../src/lib/queue/topology.js";
import { createJobProcessor } from "../../src/lib/queue/worker-factory.js";
import { StandInEmbeddingProvider, STAND_IN_EMBEDDING_MODEL } from "../../src/modules/prompts/adapters/stand-in-embedding-provider.js";
import type { PromptNaturaliser } from "../../src/modules/prompts/ports/naturaliser.js";
import { PromptsService } from "../../src/modules/prompts/prompts.service.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";

// STORY-045 / owner decision 95(a) - the background generation job, end to end, under the RUNTIME role (`nominara_app`, no BYPASSRLS), through
// the real `createJobProcessor` (signature verified first, the phases split into separate tenant transactions, the final-attempt recovery).
//
// What the unit specs cannot show and this one does: the statements EXECUTE against the real table and constraints; the embedder is awaited
// with no transaction open; a redelivery and a racing double delivery write the pass once; a failed generation charges nothing; and a job
// signed for another workspace touches nothing.

const KEYS = { current: { kid: "k1", key: Buffer.from("prompt-generate-test-signing-key-32") } };
const ENTRY = QUEUE_TOPOLOGY.find((entry) => entry.name === "prompt.generate")!;

// The brand context the other promptgen specs use: enough slots that every archetype fills.
const FULL_CONTEXT = {
  brand_context: {
    competitors: [{ name: "Salesforce" }],
    personas: ["marketing_director"],
    size_bands: ["mid_market"],
    integrations: ["slack"],
    compliance_terms: ["soc2"],
    capabilities: ["pipeline_automation"],
  },
};

describe("STORY-045 / decision 95(a) · the prompt.generate job", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let appPool: Pool;
  let workspaceId: string;
  let projectId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18").withDatabase("nominara_test").withUsername("nominara").withPassword("nominara").start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await migrateUp(db);
    const password = resolvePassword("nominara_app", {});
    await db.query(`ALTER ROLE nominara_app PASSWORD ${db.escapeLiteral(password)}`);
    appPool = new Pool({ host: container.getHost(), port: container.getMappedPort(5432), database: container.getDatabase(), user: "nominara_app", password, max: 8 });
  }, 300_000);

  afterAll(async () => {
    await appPool.end();
    await db.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.query("TRUNCATE prompt_generations, credit_ledger, credit_wallets, usage_ledger, tracked_prompts, projects, workspaces CASCADE");
    ({ workspaceId, projectId } = await seedWorkspace("HubSpot CRM"));
  });

  async function seedWorkspace(name: string): Promise<{ workspaceId: string; projectId: string }> {
    const ws = randomUUID();
    const project = randomUUID();
    await db.query("INSERT INTO workspaces (id, name, slug, plan_key) VALUES ($1, 'W', $2, 'growth')", [ws, `w-${randomUUID().slice(0, 8)}`]);
    await db.query(
      `INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain, category_slug, verticals)
       VALUES ($1, $2, $3, $4, 'https://hubspot.com', 'hubspot.com', 'crm', ARRAY['b2b_saas'])`,
      [project, ws, name, `p-${randomUUID().slice(0, 8)}`],
    );
    await db.query(
      `INSERT INTO credit_wallets (workspace_id, included_balance, cycle_start, cycle_end) VALUES ($1, 100, CURRENT_DATE, CURRENT_DATE + 30)`,
      [ws],
    );
    return { workspaceId: ws, projectId: project };
  }

  /** What POST /prompts/generate does in its transaction: records the pending row (through the real service, as the runtime role). */
  async function requestGeneration(ws: string, project: string, request: Record<string, unknown> = {}): Promise<string> {
    const service = new PromptsService(undefined, { enqueueTenantJob: async () => ({}) } as never);
    const client = await appPool.connect();
    try {
      const accepted = await withTenantContext(client, { workspaceId: ws, actorId: randomUUID() }, () => service.requestGeneration(project, request as never));
      return accepted.generation_batch_id;
    } finally {
      client.release();
    }
  }

  const standIn = new StandInEmbeddingProvider();
  const standInEmbedder = { model: STAND_IN_EMBEDDING_MODEL, embed: (texts: readonly string[]) => standIn.embed(texts) };

  /** One delivery of the job, signed for `ws`, through the real processor. `attemptsMade` 0 of 3 unless told. */
  async function deliver(ws: string, project: string, generationId: string, deps: PromptGenerateDeps = {}, attemptsMade = 0): Promise<void> {
    const context = { pool: appPool, env: { NODE_ENV: "test" } } as unknown as QueueHandlerContext;
    const process = createJobProcessor(ENTRY, {
      keys: KEYS,
      getClient: () => appPool.connect(),
      releaseClient: (client) => (client as unknown as { release(): void }).release(),
      process: createPromptGenerateHandler(context, { naturaliser: null, embedder: standInEmbedder, ...deps }),
    });
    const payload = { generationId, projectId: project, workspaceId: ws, kid: "k1" };
    await process({ data: signQueueJobPayload(payload, KEYS.current.key), attemptsMade, opts: { attempts: 3 } } as unknown as Job);
  }

  const generation = async (id: string): Promise<PromptGeneration | undefined> => {
    const row = (await db.query<{ status: PromptGeneration["status"]; result: PromptGeneration["result"]; failure_code: PromptGeneration["failure_code"]; completed_at: Date | null; updated_at: Date }>(
      "SELECT status, result, failure_code, completed_at, updated_at FROM prompt_generations WHERE id = $1",
      [id],
    )).rows[0];
    return row === undefined ? undefined : ({ ...row } as unknown as PromptGeneration);
  };
  const promptCount = async (project = projectId): Promise<number> => Number((await db.query("SELECT count(*) AS n FROM tracked_prompts WHERE project_id = $1", [project])).rows[0].n);
  const money = async (ws = workspaceId) => ({
    wallet: (await db.query("SELECT included_balance, purchased_balance, reserved, lifetime_spent FROM credit_wallets WHERE workspace_id = $1", [ws])).rows[0],
    ledger: Number((await db.query("SELECT count(*) AS n FROM credit_ledger WHERE workspace_id = $1", [ws])).rows[0].n),
    usage: Number((await db.query("SELECT count(*) AS n FROM usage_ledger WHERE workspace_id = $1", [ws])).rows[0].n),
  });
  const idleInTransaction = async (): Promise<number> =>
    Number((await db.query("SELECT count(*) AS n FROM pg_stat_activity WHERE usename = 'nominara_app' AND state LIKE 'idle in transaction%'")).rows[0].n);

  it("D95a-1 · a requested generation is pending until the job runs, then succeeded with fifteen archived prompts and the old response as its result", async () => {
    const id = await requestGeneration(workspaceId, projectId, FULL_CONTEXT);
    expect((await generation(id))?.status).toBe("pending");
    expect(await promptCount()).toBe(0);

    await deliver(workspaceId, projectId, id, { embedder: standInEmbedder });

    const settled = await generation(id);
    expect(settled?.status).toBe("succeeded");
    expect(settled?.completed_at).not.toBeNull();
    expect(settled?.result?.summary).toMatchObject({ requested: 15, accepted: 15, rejected_duplicate: 0, activated: 0 });
    expect(settled?.result?.variants).toHaveLength(15);
    expect(settled?.result?.generation_batch_id).toBe(id);
    const rows = await db.query<{ status: string; generation_batch_id: string }>("SELECT status, generation_batch_id FROM tracked_prompts WHERE project_id = $1", [projectId]);
    expect(rows.rows).toHaveLength(15);
    expect(rows.rows.every((row) => row.status === "archived" && row.generation_batch_id === id)).toBe(true);
  }, 60_000);

  it("D95a-2 · a near-duplicate of an existing prompt is rejected by vector dedupe in the job, the earlier prompt kept, and rejected[] says why", async () => {
    await db.query("UPDATE projects SET category_slug = 'crm' WHERE id = $1", [projectId]);
    // 14 of the 15 words of the buyer_shortlist template plus one more: a different text_hash (exact-hash dedupe cannot catch it) at a bag-of-words cosine of 0.966.
    const nearText = "Shortlist 3 crm options for mid market b2b saas teams and explain the trade-offs please";
    const existingId = randomUUID();
    const vector = (await standIn.embed([nearText])).vectors[0]!;
    await db.query(
      `INSERT INTO tracked_prompts (id, workspace_id, project_id, text, text_hash, intent_archetype, funnel_stage, status, embedding, embedding_model)
       VALUES ($1, $2, $3, $4, sha256($5::bytea), 'recommendation', 'consideration', 'active', $6::halfvec, $7)`,
      [existingId, workspaceId, projectId, nearText, Buffer.from(nearText, "utf8"), JSON.stringify(vector), STAND_IN_EMBEDDING_MODEL],
    );
    const id = await requestGeneration(workspaceId, projectId, FULL_CONTEXT);

    await deliver(workspaceId, projectId, id);

    const result = (await generation(id))!.result!;
    const rejected = result.rejected.find((row) => row.intent_archetype === "buyer_shortlist");
    expect(rejected).toMatchObject({ reason: "rejected_duplicate", conflicting_prompt_id: existingId });
    expect(result.summary.rejected_duplicate).toBe(result.rejected.length);
    const stored = await db.query<{ text: string }>("SELECT text FROM tracked_prompts WHERE project_id = $1 AND deleted_at IS NULL", [projectId]);
    expect(stored.rows.map((row) => row.text)).toContain(nearText);
    expect(stored.rows.map((row) => row.text)).not.toContain(rejected!.text);
    // Measured, so a number - never the not-measured null.
    expect(result.variants.length).toBeGreaterThan(0);
    expect(result.variants.every((variant) => variant.novelty.max_cosine_to_existing !== null)).toBe(true);
  }, 60_000);

  it("D95a-3 · the embedder and the naturaliser are awaited with NO transaction open on the runtime role", async () => {
    const id = await requestGeneration(workspaceId, projectId, FULL_CONTEXT);
    const open: number[] = [];
    const naturaliser: PromptNaturaliser = {
      naturalise: async (request) => {
        open.push(await idleInTransaction());
        return request.lines;
      },
    } as PromptNaturaliser;
    const embedder = {
      model: STAND_IN_EMBEDDING_MODEL,
      embed: async (texts: readonly string[]) => {
        open.push(await idleInTransaction());
        return standIn.embed(texts);
      },
    };
    await deliver(workspaceId, projectId, id, { naturaliser, embedder, cache: { get: async () => undefined, set: async () => undefined } as never });
    expect(open.length).toBeGreaterThanOrEqual(2);
    expect(open.every((count) => count === 0), `connections idle in transaction at each external call: ${JSON.stringify(open)}`).toBe(true);
    expect((await generation(id))?.status).toBe("succeeded");
  }, 60_000);

  it("D95a-4 · a redelivery after success writes nothing and calls nothing: same prompts, same result, same row", async () => {
    const id = await requestGeneration(workspaceId, projectId, FULL_CONTEXT);
    await deliver(workspaceId, projectId, id);
    const before = await generation(id);
    const idsBefore = (await db.query("SELECT id FROM tracked_prompts WHERE project_id = $1 ORDER BY id", [projectId])).rows;
    let embedCalls = 0;
    const counting = { model: STAND_IN_EMBEDDING_MODEL, embed: async (texts: readonly string[]) => { embedCalls += 1; return standIn.embed(texts); } };

    await deliver(workspaceId, projectId, id, { embedder: counting }, 1);

    expect(embedCalls).toBe(0);
    expect(await generation(id)).toEqual(before);
    expect((await db.query("SELECT id FROM tracked_prompts WHERE project_id = $1 ORDER BY id", [projectId])).rows).toEqual(idsBefore);
  }, 60_000);

  it("D95a-5 · two deliveries racing past prepare write the pass ONCE (the commit serialises on the generation row)", async () => {
    const id = await requestGeneration(workspaceId, projectId, FULL_CONTEXT);
    let arrived = 0;
    let open!: () => void;
    const barrier = new Promise<void>((resolve) => { open = resolve; });
    const racing = {
      model: STAND_IN_EMBEDDING_MODEL,
      embed: async (texts: readonly string[]) => {
        arrived += 1;
        if (arrived >= 2) open();
        await barrier;
        return standIn.embed(texts);
      },
    };
    await Promise.all([deliver(workspaceId, projectId, id, { embedder: racing }), deliver(workspaceId, projectId, id, { embedder: racing })]);
    expect(arrived, "both deliveries reached the external call before either committed").toBe(2);
    expect(await promptCount()).toBe(15);
    // The FIRST committer's result stands: the loser must not overwrite it with an all-rejected pass.
    const settled = await generation(id);
    expect(settled?.status).toBe("succeeded");
    expect(settled?.result?.variants).toHaveLength(15);
    expect(settled?.result?.rejected).toHaveLength(0);
    const duplicates = await db.query("SELECT count(*) - count(DISTINCT text_hash) AS n FROM tracked_prompts WHERE project_id = $1", [projectId]);
    expect(Number(duplicates.rows[0].n)).toBe(0);
  }, 60_000);

  // A comparison that cannot run is a failure the job must be honest about: the embedder returns a vector of the wrong width, so Postgres refuses
  // the cast and `compare` throws (fail CLOSED - unlike an embedder outage, which falls back to exact-hash dedupe).
  const brokenCompare = { model: STAND_IN_EMBEDDING_MODEL, embed: async (texts: readonly string[]) => ({ vectors: texts.map(() => [1, 0, 0]), totalTokens: 1 }) };

  it("D95a-6 · a failure before the last attempt rides the retry ladder: the job throws, the generation stays running, nothing is written", async () => {
    const id = await requestGeneration(workspaceId, projectId, FULL_CONTEXT);
    await expect(deliver(workspaceId, projectId, id, { embedder: brokenCompare }, 0)).rejects.toThrow();
    expect((await generation(id))?.status).toBe("running");
    expect(await promptCount()).toBe(0);
  }, 60_000);

  it("D95a-7 · a failure on the LAST attempt settles the generation failed(generation_failed), without throwing, with no result and no prompts", async () => {
    const id = await requestGeneration(workspaceId, projectId, FULL_CONTEXT);
    await expect(deliver(workspaceId, projectId, id, { embedder: brokenCompare }, 2)).resolves.toBeUndefined();
    const settled = await generation(id);
    expect(settled).toMatchObject({ status: "failed", failure_code: "generation_failed", result: null });
    expect(settled?.completed_at).not.toBeNull();
    expect(await promptCount()).toBe(0);
  }, 60_000);

  it("D95a-8 · a failed generation charges nothing: the wallet, the credit ledger and the usage ledger are exactly as they were", async () => {
    const before = await money();
    const id = await requestGeneration(workspaceId, projectId, FULL_CONTEXT);
    await deliver(workspaceId, projectId, id, { embedder: brokenCompare }, 2);
    expect((await generation(id))?.status).toBe("failed");
    expect(await money()).toEqual(before);
  }, 60_000);

  it("D95a-9 · a SUCCEEDED generation charges nothing either (FR-FAN-01g)", async () => {
    const before = await money();
    const id = await requestGeneration(workspaceId, projectId, FULL_CONTEXT);
    await deliver(workspaceId, projectId, id);
    expect((await generation(id))?.status).toBe("succeeded");
    expect(await money()).toEqual(before);
  }, 60_000);

  it("D95a-10 · a failed generation redelivered later cannot be resurrected or rewritten", async () => {
    const id = await requestGeneration(workspaceId, projectId, FULL_CONTEXT);
    await deliver(workspaceId, projectId, id, { embedder: brokenCompare }, 2);
    const failed = await generation(id);
    await deliver(workspaceId, projectId, id, {}, 0);
    expect(await generation(id)).toEqual(failed);
    expect(await promptCount()).toBe(0);
  }, 60_000);

  it("D95a-11 · a project deleted before the job runs settles failed(project_not_found) at once, not after the ladder", async () => {
    const id = await requestGeneration(workspaceId, projectId, FULL_CONTEXT);
    await db.query("UPDATE projects SET deleted_at = now() WHERE id = $1", [projectId]);
    await expect(deliver(workspaceId, projectId, id, {}, 0)).resolves.toBeUndefined();
    expect(await generation(id)).toMatchObject({ status: "failed", failure_code: "project_not_found" });
  }, 60_000);

  it("D95a-12 · an embedder OUTAGE is not a failed generation: the pass completes on exact-hash dedupe with novelty not measured (null, never 0)", async () => {
    const id = await requestGeneration(workspaceId, projectId, FULL_CONTEXT);
    await deliver(workspaceId, projectId, id, { embedder: { model: "m", embed: async () => { throw new Error("provider down"); } } });
    const result = (await generation(id))!.result!;
    expect(result.variants).toHaveLength(15);
    expect(result.variants.every((variant) => variant.novelty.max_cosine_to_existing === null)).toBe(true);
  }, 60_000);

  it("D95a-13 · tenancy - a job signed for workspace B that names A's generation does nothing, and B cannot read A's generation", async () => {
    const b = await seedWorkspace("Other Co");
    const id = await requestGeneration(workspaceId, projectId, FULL_CONTEXT);
    await deliver(b.workspaceId, projectId, id);
    expect((await generation(id))?.status).toBe("pending");
    expect(await promptCount()).toBe(0);

    const service = new PromptsService(undefined, undefined);
    const client = await appPool.connect();
    try {
      await expect(
        withTenantContext(client, { workspaceId: b.workspaceId, actorId: randomUUID() }, () => service.readGeneration(projectId, id)),
      ).rejects.toMatchObject({ name: expect.stringMatching(/NotFound/) });
      const own = await withTenantContext(client, { workspaceId, actorId: randomUUID() }, () => service.readGeneration(projectId, id));
      expect(own).toMatchObject({ generation_batch_id: id, status: "pending", result: null });
    } finally {
      client.release();
    }
  }, 60_000);

  it("D95a-14 · the free allowance is not blocked while a generation is parked in its naturaliser, and the two never collide on the hash index", async () => {
    const id = await requestGeneration(workspaceId, projectId, {});
    const discoveryConn = new Client({ connectionString: container.getConnectionUri() });
    await discoveryConn.connect();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const inNaturaliser = new Promise<void>((resolve) => { entered = resolve; });
    const naturaliser = { naturalise: async (request: { lines: readonly string[] }) => { entered(); await gate; return request.lines; } } as PromptNaturaliser;
    try {
      const running = deliver(workspaceId, projectId, id, { naturaliser, cache: { get: async () => undefined, set: async () => undefined } as never });
      await inNaturaliser;

      await discoveryConn.query("BEGIN");
      const blocked = Symbol("blocked");
      const outcome = await Promise.race([
        generateFreeAllowance(discoveryConn, { workspaceId, projectId, allowance: 10 }),
        new Promise<symbol>((resolve) => setTimeout(() => resolve(blocked), 4_000)),
      ]);
      expect(outcome).not.toBe(blocked);
      await discoveryConn.query("COMMIT");

      release();
      await running;

      // What discovery committed meanwhile is the same grammar's output: the job reports it as duplicates, it does not fail.
      const result = (await generation(id))!.result!;
      expect(result.rejected.some((row) => row.reason === "rejected_duplicate")).toBe(true);
      expect(result.summary.accepted).toBe(result.variants.length);
      const dup = await db.query("SELECT count(*) - count(DISTINCT text_hash) AS n FROM tracked_prompts WHERE project_id = $1 AND deleted_at IS NULL", [projectId]);
      expect(Number(dup.rows[0].n)).toBe(0);
    } finally {
      release();
      await discoveryConn.query("ROLLBACK").catch(() => undefined);
      await discoveryConn.end();
    }
  }, 60_000);
});
