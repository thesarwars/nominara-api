import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { compareInSql, judgeVectors } from "../../src/lib/promptgen/vector-dedupe.js";
import { StandInEmbeddingProvider, STAND_IN_EMBEDDING_MODEL } from "../../src/modules/prompts/adapters/stand-in-embedding-provider.js";
import type { CandidateEmbedder } from "../../src/modules/prompts/ports/candidate-embedder.js";
import { PromptsService } from "../../src/modules/prompts/prompts.service.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";

// STORY-045 AC6 - the vector half of §4 step 5 against REAL pgvector. The SQL is the unit under test: every cosine below is computed
// by Postgres, and the stand-in embedder (owner decision 2026-10-28 #1) supplies the vectors for the service-level case. No network.

const DIM = 1536;
const MODEL = "test-model-1536";

/** A unit vector whose cosine to e0 is exactly `cosine`. */
function vecAt(cosine: number): number[] {
  const v = new Array<number>(DIM).fill(0);
  v[0] = cosine;
  v[1] = Math.sqrt(1 - cosine * cosine);
  return v;
}
const e0 = vecAt(1);

describe("STORY-045 AC6 · vector dedupe against pgvector", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let pool: Pool;
  let workspaceId: string;
  let projectId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await migrateUp(db);
    pool = new Pool({ connectionString: container.getConnectionUri() });
  }, 300_000);

  afterAll(async () => {
    await pool.end();
    await db.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.query("TRUNCATE tracked_prompts, projects, workspaces CASCADE");
    workspaceId = randomUUID();
    projectId = randomUUID();
    await db.query("INSERT INTO workspaces (id, name, slug, plan_key) VALUES ($1, 'W', $2, 'growth')", [workspaceId, `w-${randomUUID().slice(0, 8)}`]);
    await db.query(
      `INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain)
       VALUES ($1, $2, 'HubSpot CRM', $3, 'https://hubspot.com', 'hubspot.com')`,
      [projectId, workspaceId, `p-${randomUUID().slice(0, 8)}`],
    );
  });

  async function addPrompt(text: string, over: { vector?: readonly number[] | null; model?: string; deleted?: boolean; project?: string } = {}): Promise<string> {
    const id = randomUUID();
    const vector = over.vector === undefined ? e0 : over.vector;
    await db.query(
      `INSERT INTO tracked_prompts (id, workspace_id, project_id, text, text_hash, intent_archetype, funnel_stage, status, embedding, embedding_model, deleted_at)
       VALUES ($1, $2, $3, $4, sha256($5::bytea), 'recommendation', 'consideration', 'active', $6::halfvec, $7, $8)`,
      [
        id,
        workspaceId,
        over.project ?? projectId,
        text,
        Buffer.from(text, "utf8"),
        vector === null ? null : JSON.stringify(vector),
        vector === null ? null : (over.model ?? MODEL),
        over.deleted === true ? new Date() : null,
      ],
    );
    return id;
  }

  const compare = (vectors: readonly (readonly number[])[], model = MODEL) => compareInSql(db, projectId, model, vectors);

  it("scenario 10 - 0.93 is rejected by generation dedupe, 0.85 is not, and the nearest prompt is named", async () => {
    const existing = await addPrompt("existing");
    const comparison = await compare([vecAt(0.93), vecAt(0.85)]);
    const [near, far] = judgeVectors(comparison);

    expect(near).toMatchObject({ reject: true, conflictingPromptId: existing, nearestPromptId: existing });
    expect(near!.maxCosine).toBeCloseTo(0.93, 2);
    expect(far!.reject).toBe(false);
    expect(far!.maxCosine).toBeCloseTo(0.85, 2);
  });

  it("the threshold is 0.92 and inclusive: just over rejects, just under keeps", async () => {
    await addPrompt("existing");
    const [over, under] = judgeVectors(await compare([vecAt(0.925), vecAt(0.915)]));
    expect(over!.reject).toBe(true);
    expect(under!.reject).toBe(false);
  });

  it("null stays null: a project with no embedded prompts reports NOT MEASURED, and an orthogonal neighbour is a measured 0", async () => {
    const [nothing] = judgeVectors(await compare([e0]));
    expect(nothing).toEqual({ reject: false, conflictingPromptId: null, maxCosine: null, nearestPromptId: null });

    const orthogonal = new Array<number>(DIM).fill(0);
    orthogonal[2] = 1;
    await addPrompt("existing");
    const [measured] = judgeVectors(await compare([orthogonal]));
    expect(measured!.maxCosine).toBe(0);
    expect(measured!.nearestPromptId).not.toBeNull();
  });

  it("EC-23 - a prompt embedded under another model is not a neighbour, even with an identical vector", async () => {
    await addPrompt("existing", { model: "some-other-model" });
    const [verdict] = judgeVectors(await compare([e0]));
    expect(verdict!.reject).toBe(false);
    expect(verdict!.maxCosine).toBeNull();
  });

  it("a soft-deleted prompt, an un-embedded prompt and another project's prompt are not neighbours", async () => {
    const otherProject = randomUUID();
    await db.query(
      `INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain) VALUES ($1, $2, 'Other', $3, 'https://o.test', 'o.test')`,
      [otherProject, workspaceId, `p-${randomUUID().slice(0, 8)}`],
    );
    await addPrompt("deleted", { deleted: true });
    await addPrompt("no vector yet", { vector: null });
    await addPrompt("elsewhere", { project: otherProject });
    const [verdict] = judgeVectors(await compare([e0]));
    expect(verdict).toEqual({ reject: false, conflictingPromptId: null, maxCosine: null, nearestPromptId: null });
  });

  it("the nearest of SEVERAL existing prompts is the one reported", async () => {
    await addPrompt("far", { vector: vecAt(0.5) });
    const close = await addPrompt("close", { vector: vecAt(0.97) });
    await addPrompt("middling", { vector: vecAt(0.8) });
    const [verdict] = judgeVectors(await compare([e0]));
    expect(verdict!.nearestPromptId).toBe(close);
  });

  it("within the batch, pairs at or above the threshold come back earlier-first and the later is rejected", async () => {
    const comparison = await compare([vecAt(1), vecAt(0.5), vecAt(0.99)]);
    expect(comparison.batchPairs).toHaveLength(1);
    expect(comparison.batchPairs[0]).toMatchObject({ earlier: 0, later: 2 });
    expect(judgeVectors(comparison).map((v) => v.reject)).toEqual([false, false, true]);
  });

  it("an empty batch makes no query", async () => {
    expect(await compare([])).toEqual({ nearest: [], batchPairs: [] });
  });

  it("scenario 6, end to end - the SERVICE rejects a near-duplicate of an existing prompt, keeps the earlier one, and reports why", async () => {
    const embedder: CandidateEmbedder & { calls: number } = {
      model: STAND_IN_EMBEDDING_MODEL,
      calls: 0,
      async embed(texts) {
        this.calls += 1;
        return (await new StandInEmbeddingProvider().embed(texts)).vectors;
      },
    };
    // 14 of the 15 words of a candidate template plus one more word: a different text_hash (so exact-hash dedupe cannot catch it) and a
    // bag-of-words cosine of 14/sqrt(14*15) = 0.966.
    const nearText = "Shortlist 3 crm options for mid market b2b saas teams and explain the trade-offs please";
    const stand = new StandInEmbeddingProvider();
    const existingId = await addPrompt(nearText, { vector: (await stand.embed([nearText])).vectors[0]!, model: STAND_IN_EMBEDDING_MODEL });

    const cache = { get: async () => undefined, set: async () => undefined } as never;
    const service = new PromptsService(cache, null, embedder);
    const client = await pool.connect();
    try {
      await db.query("UPDATE projects SET category_slug = 'crm', verticals = ARRAY['b2b_saas'] WHERE id = $1", [projectId]);
      const response = await withTenantContext(client, { workspaceId, actorId: randomUUID() }, () =>
        service.generate(projectId, {
          brand_context: {
            competitors: [{ name: "Salesforce" }],
            personas: ["marketing_director"],
            size_bands: ["mid_market"],
            integrations: ["slack"],
            compliance_terms: ["soc2"],
            capabilities: ["pipeline_automation"],
          },
        } as never),
      );

      const rejected = response.rejected.find((row) => row.intent_archetype === "buyer_shortlist");
      expect(rejected).toMatchObject({ reason: "rejected_duplicate", conflicting_prompt_id: existingId });
      expect(response.summary.rejected_duplicate).toBe(response.rejected.length);
      // The earlier prompt is untouched and the rejected text was never inserted.
      const stored = await db.query<{ text: string }>("SELECT text FROM tracked_prompts WHERE project_id = $1 AND deleted_at IS NULL", [projectId]);
      expect(stored.rows.map((r) => r.text)).toContain(nearText);
      expect(stored.rows.map((r) => r.text)).not.toContain(rejected!.text);
      // Measured, so a number - never the not-measured null.
      expect(response.variants.every((v) => v.novelty.max_cosine_to_existing !== null)).toBe(true);
      expect(response.variants.length).toBeGreaterThan(0);
    } finally {
      client.release();
    }
  });
});
