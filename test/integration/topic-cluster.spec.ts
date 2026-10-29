import { createHash, randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { Job } from "bullmq";
import { Client, Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { topicClusterJobPayloadSchema } from "../../contracts/projects/index.js";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { projectQueueLockKey } from "../../src/lib/queue/locks.js";
import { signQueueJobPayload } from "../../src/lib/queue/envelope.js";
import { createEmbedBatchHandler } from "../../src/lib/queue/handlers/embed-batch.handler.js";
import { createTopicClusterHandler } from "../../src/lib/queue/handlers/topic-cluster.handler.js";
import type { QueueHandlerContext } from "../../src/lib/queue/handlers.js";
import { QUEUE_TOPOLOGY } from "../../src/lib/queue/topology.js";
import { createJobProcessor } from "../../src/lib/queue/worker-factory.js";
import { promptSetHash, snapshotClusters, writeClusters } from "../../src/lib/topics/cluster.js";
import { isReadableLabel, type TopicLabeller } from "../../src/lib/topics/labeller.js";
import { findProjectsDueForClustering, runTopicClusterSweep } from "../../src/lib/topics/sweep.js";
import { StandInEmbeddingProvider, STAND_IN_EMBEDDING_MODEL } from "../../src/modules/prompts/adapters/stand-in-embedding-provider.js";

// STORY-047 - topic.cluster against real Postgres + pgvector, the handler running as the RUNTIME role (nominara_app, no BYPASSRLS).
//
// Vectors are written directly (axis-aligned, with a little noise) so every cosine in a scenario is known by construction. The
// stand-in provider test at the end proves the pipeline embed.batch -> topic.cluster, not the model: ACs that need a REAL embedding
// (label quality on real prompts) stay open until the OpenAI key is configured and one run is read by a person.

const counters: { name: string; labels: Record<string, string> }[] = [];
vi.mock("../../src/lib/telemetry/metrics.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/telemetry/metrics.js")>("../../src/lib/telemetry/metrics.js");
  return {
    ...actual,
    incrementCounter: (name: string, labels: Record<string, string> = {}) => {
      counters.push({ name, labels });
      actual.incrementCounter(name, labels);
    },
  };
});

const KEYS = { current: { kid: "k1", key: Buffer.from("topic-cluster-test-signing-key-32") } };
const ENTRY = QUEUE_TOPOLOGY.find((entry) => entry.name === "topic.cluster")!;
const MODEL = "test-model-1536";

function vec(parts: Record<number, number>): string {
  const v = new Array<number>(1536).fill(0);
  for (const [axis, value] of Object.entries(parts)) v[Number(axis)] = value;
  return `[${v.join(",")}]`;
}
/** Member `i` of group `g`: axis g = 1, a private noise axis = 0.3 -> cosine to a sibling is 1/1.09 = 0.917 (above the 0.82 floor). */
const member = (g: number, i: number): string => vec({ [g]: 1, [100 + g * 20 + i]: 0.3 });

describe("STORY-047 - topic.cluster", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let pool: Pool;
  let workspaceId: string;
  let projectId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18").withDatabase("nominara_test").withUsername("nominara").withPassword("nominara").start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await migrateUp(db);
    const password = resolvePassword("nominara_app", {});
    await db.query(`ALTER ROLE nominara_app PASSWORD ${db.escapeLiteral(password)}`);
    pool = new Pool({ host: container.getHost(), port: container.getMappedPort(5432), database: container.getDatabase(), user: "nominara_app", password, max: 6 });
  }, 300_000);

  afterAll(async () => {
    await pool.end();
    await db.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.query("TRUNCATE usage_ledger, usage_counters, tracked_prompts, topic_clusters, projects, workspaces CASCADE");
    [workspaceId, projectId] = await newProject();
  });

  async function newProject(): Promise<[string, string]> {
    const ws = randomUUID();
    const project = randomUUID();
    await db.query("INSERT INTO workspaces (id, name, slug, plan_key) VALUES ($1, 'W', $2, 'growth')", [ws, `w-${randomUUID().slice(0, 8)}`]);
    await db.query(
      `INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain) VALUES ($1, $2, 'P', $3, 'https://example.test', 'example.test')`,
      [project, ws, `p-${randomUUID().slice(0, 8)}`],
    );
    return [ws, project];
  }

  async function addPrompt(
    text: string,
    embedding: string | null,
    over: { funnel?: string; status?: string; model?: string | null; ws?: string; project?: string; deleted?: boolean } = {},
  ): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO tracked_prompts (id, workspace_id, project_id, text, text_hash, intent_archetype, funnel_stage, status, embedding, embedding_model, deleted_at)
       VALUES ($1, $2, $3, $4, sha256($5::bytea), 'recommendation', $6, $7, $8::halfvec, $9, $10)`,
      [
        id, over.ws ?? workspaceId, over.project ?? projectId, text, Buffer.from(`${text}${id}`, "utf8"), over.funnel ?? "consideration",
        over.status ?? "active", embedding, embedding === null ? null : over.model === undefined ? MODEL : over.model, over.deleted === true ? new Date() : null,
      ],
    );
    return id;
  }

  const TOPICS = [
    (i: number) => `What is the best CRM software for enterprise teams? variant ${String(i)}`,
    (i: number) => `How does pricing compare across analytics vendors? variant ${String(i)}`,
    (i: number) => `Is the platform secure and compliant with SOC 2? variant ${String(i)}`,
  ];

  /** `groups` clusters of `size` prompts each. */
  async function seedGroups(groups: number, size: number, funnel = "consideration"): Promise<string[][]> {
    const out: string[][] = [];
    for (let g = 0; g < groups; g += 1) {
      const ids: string[] = [];
      for (let i = 0; i < size; i += 1) ids.push(await addPrompt(TOPICS[g]!(i), member(g, i), { funnel }));
      out.push(ids);
    }
    return out;
  }

  class StubLabeller implements TopicLabeller {
    calls = 0;
    constructor(private readonly onCall?: () => Promise<void>) {}
    async label(request: { prompts: readonly string[] }): Promise<string> {
      this.calls += 1;
      await this.onCall?.();
      const first = request.prompts[0] ?? "";
      return first.includes("CRM") ? "Enterprise CRM" : first.includes("pricing") ? "Pricing comparison" : first.includes("secure") ? "Security & compliance" : "Other topic";
    }
  }

  function handler(labeller: TopicLabeller = new StubLabeller()) {
    const context = { pool: undefined, env: { NODE_ENV: "test" } } as unknown as QueueHandlerContext;
    return createTopicClusterHandler(context, { labeller });
  }
  function job(project = projectId, ws = workspaceId, reason: "initial" | "prompt_set_change" | "weekly" = "initial"): Job {
    const payload = topicClusterJobPayloadSchema.parse({ workspaceId: ws, kid: "k1", projectId: project, reason });
    return { data: signQueueJobPayload(payload, KEYS.current.key) } as unknown as Job;
  }
  async function run(h = handler(), j: Job = job()): Promise<unknown> {
    const process = createJobProcessor(ENTRY, { keys: KEYS, getClient: () => pool.connect(), releaseClient: (c) => (c as PoolClient).release(), process: h });
    return process(j);
  }

  async function clusters(): Promise<{ id: string; label: string; label_source: string; prompt_count: number; commercial_intent: number; has_centroid: boolean; embedding_model: string | null; visibility_score: string | null }[]> {
    const r = await db.query(
      `SELECT id, label, label_source, prompt_count, commercial_intent, centroid IS NOT NULL AS has_centroid, embedding_model, visibility_score::text
         FROM topic_clusters WHERE project_id = $1 ORDER BY label`,
      [projectId],
    );
    return r.rows;
  }
  async function assignments(): Promise<Map<string, string | null>> {
    const r = await db.query<{ id: string; cluster_id: string | null }>("SELECT id, cluster_id FROM tracked_prompts WHERE project_id = $1", [projectId]);
    return new Map(r.rows.map((row) => [row.id, row.cluster_id]));
  }
  async function orphans(): Promise<number> {
    const r = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM tracked_prompts p LEFT JOIN topic_clusters c ON c.id = p.cluster_id WHERE p.cluster_id IS NOT NULL AND c.id IS NULL`,
    );
    return Number(r.rows[0]!.n);
  }

  // ---- AC1, AC2, scenario 1 -------------------------------------------------------------------------------------------

  it("AC1 / AC2 / scenario 1 - a mixed set clusters at the floor: a centroid, a member count, a readable label and the model per cluster", async () => {
    const groups = await seedGroups(3, 4);
    await run();
    const rows = await clusters();
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.prompt_count).toBe(4);
      expect(row.has_centroid).toBe(true);
      expect(row.embedding_model).toBe(MODEL);
      expect(row.label_source).toBe("auto");
      expect(isReadableLabel(row.label)).toBe(true);
    }
    expect(rows.map((r) => r.label).sort()).toEqual(["Enterprise CRM", "Pricing comparison", "Security & compliance"]);
    const a = await assignments();
    for (const ids of groups) expect(new Set(ids.map((id) => a.get(id))).size).toBe(1);
    expect(new Set(groups.map((ids) => a.get(ids[0]!))).size).toBe(3);
  });

  it("AC2 - a model that returns an identifier gets the template label instead", async () => {
    await seedGroups(1, 3);
    await run(handler({ label: () => Promise.resolve("0198f3a1-7c11-7000-8000-000000000001") }));
    const [row] = await clusters();
    // Which member is "most representative" is a tie among equidistant members (broken by a random id), so the variant digit is not pinned.
    expect(row!.label).toMatch(/^Best CRM software for enterprise teams variant \d$/u);
    expect(isReadableLabel(row!.label)).toBe(true);
  });

  // ---- AC3, scenario 2 ------------------------------------------------------------------------------------------------

  it("AC3 / scenario 2 - rename a cluster, then recompute: the renamed label survives, on the same cluster, still marked user", async () => {
    await seedGroups(3, 4);
    await run();
    const before = (await clusters()).find((c) => c.label === "Pricing comparison")!;
    await db.query("UPDATE topic_clusters SET label = 'Our vendor pricing', label_source = 'user' WHERE id = $1", [before.id]);
    // The prompt set changes: a new member joins the renamed topic and another topic loses one.
    await addPrompt(TOPICS[1]!(9), member(1, 9));
    await db.query("UPDATE tracked_prompts SET deleted_at = now() WHERE id = (SELECT id FROM tracked_prompts WHERE text LIKE '%CRM%' LIMIT 1)");
    await run();
    const rows = await clusters();
    const renamed = rows.find((c) => c.id === before.id)!;
    expect(renamed.label).toBe("Our vendor pricing");
    expect(renamed.label_source).toBe("user");
    expect(renamed.prompt_count).toBe(5);
    expect(rows).toHaveLength(3);
  });

  it("AC3 - the user label survives a change of embedding model (matching is by membership, not by centroid)", async () => {
    await seedGroups(2, 3);
    await run();
    const target = (await clusters()).find((c) => c.label === "Pricing comparison")!;
    await db.query("UPDATE topic_clusters SET label = 'Mine', label_source = 'user' WHERE id = $1", [target.id]);
    await db.query("UPDATE tracked_prompts SET embedding_model = 'other-model-1536' WHERE project_id = $1", [projectId]);
    await run();
    const rows = await clusters();
    expect(rows.find((c) => c.id === target.id)?.label).toBe("Mine");
    expect(rows.every((c) => c.embedding_model === "other-model-1536")).toBe(true);
  });

  it("AC3 - a matched auto cluster keeps its id and is not relabelled (the labeller is asked only about new clusters)", async () => {
    await seedGroups(2, 3);
    const first = new StubLabeller();
    await run(handler(first));
    const ids = (await clusters()).map((c) => c.id).sort();
    const second = new StubLabeller();
    await run(handler(second));
    expect(first.calls).toBe(2);
    expect(second.calls).toBe(0);
    expect((await clusters()).map((c) => c.id).sort()).toEqual(ids);
  });

  it("AC3 - two new clusters that would get the same label are kept distinct (unique per project, case-insensitive)", async () => {
    await seedGroups(2, 3);
    await run(handler({ label: () => Promise.resolve("Same topic") }));
    const labels = (await clusters()).map((c) => c.label).sort();
    expect(labels).toEqual(["Same topic", "Same topic (2)"]);
  });

  it("AC3 - a new cluster whose label collides with a user's label gets a distinct one", async () => {
    await seedGroups(1, 3);
    await run();
    const [first] = await clusters();
    await db.query("UPDATE topic_clusters SET label = 'Same topic', label_source = 'user' WHERE id = $1", [first!.id]);
    for (let i = 0; i < 3; i += 1) await addPrompt(TOPICS[2]!(i), member(2, i));
    await run(handler({ label: () => Promise.resolve("same TOPIC") }));
    const rows = await clusters();
    expect(rows.map((r) => r.label).sort()).toEqual(["Same topic", "same TOPIC (2)"]);
  });

  it("AC3 - a new group whose label equals the label of a cluster that GENUINELY DISSOLVES in the same run is written, not refused on the unique index", async () => {
    // Old cluster X = {A..E}. Then its members scatter: A,B move to topic 1 (joined by four new prompts), C,D to topic 2 (four new),
    // E keeps topic 0 and is alone, so an outlier. No new group holds half of the smaller side with X (2*2 < min(6,5)), so X dissolves,
    // and the labeller names the new groups with X's own label. The insert must not see X as still there (delete before insert).
    const [a, b, c, d, e] = (await seedGroups(1, 5))[0]! as [string, string, string, string, string];
    const same = { label: () => Promise.resolve("Same topic") };
    await run(handler(same));
    const [old] = await clusters();
    expect(old!.label).toBe("Same topic");
    const toGroup = async (ids: string[], g: number, from: number) => {
      for (const [k, id] of ids.entries()) await db.query("UPDATE tracked_prompts SET embedding = $2::halfvec WHERE id = $1", [id, member(g, from + k)]);
    };
    await toGroup([a, b], 1, 0);
    await toGroup([c, d], 2, 0);
    const fresh: string[] = [];
    for (let i = 0; i < 4; i += 1) fresh.push(await addPrompt(TOPICS[1]!(20 + i), member(1, 10 + i)));
    for (let i = 0; i < 4; i += 1) fresh.push(await addPrompt(TOPICS[2]!(20 + i), member(2, 10 + i)));
    await run(handler(same));
    const rows = await clusters();
    expect(rows.map((r) => r.label).sort()).toEqual(["Same topic", "Same topic (2)"]);
    expect(rows.some((r) => r.id === old!.id)).toBe(false);
    const assigned = await assignments();
    expect(assigned.get(e)).toBeNull();
    expect(new Set([a, b, ...fresh.slice(0, 4)].map((id) => assigned.get(id))).size).toBe(1);
    expect(new Set([c, d, ...fresh.slice(4)].map((id) => assigned.get(id))).size).toBe(1);
    expect(await orphans()).toBe(0);
  });

  it("AC3 - a user-renamed cluster survives an ordinary prompt edit: reworded (archived) originals do not count against it", async () => {
    // Five prompts, renamed. The user then rewords three: each original is archived (it keeps its cluster_id), each replacement starts
    // unassigned. The same topic is now {2 originals + 3 replacements}; the old cluster's membership that COULD be grouped is 2.
    const ids = (await seedGroups(1, 5))[0]!;
    await run();
    const [before] = await clusters();
    await db.query("UPDATE topic_clusters SET label = 'Our enterprise CRM', label_source = 'user' WHERE id = $1", [before!.id]);
    for (const [k, id] of ids.slice(0, 3).entries()) {
      const replacement = await addPrompt(`Reworded: ${TOPICS[0]!(30 + k)}`, member(0, 30 + k));
      await db.query("UPDATE tracked_prompts SET status = 'archived', superseded_by = $2 WHERE id = $1", [id, replacement]);
    }
    await run();
    const rows = await clusters();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(before!.id);
    expect(rows[0]!.label).toBe("Our enterprise CRM");
    expect(rows[0]!.label_source).toBe("user");
    expect(rows[0]!.prompt_count).toBe(5);
  });

  it("AC3 - a user-renamed cluster survives when most of its members are paused and replaced by near-identical prompts", async () => {
    const ids = (await seedGroups(1, 4))[0]!;
    await run();
    const [before] = await clusters();
    await db.query("UPDATE topic_clusters SET label = 'Mine', label_source = 'user' WHERE id = $1", [before!.id]);
    await db.query("UPDATE tracked_prompts SET status = 'paused' WHERE id = ANY($1::uuid[])", [ids.slice(1)]);
    for (let k = 0; k < 3; k += 1) await addPrompt(`Another way to ask ${TOPICS[0]!(40 + k)}`, member(0, 40 + k));
    await run();
    const rows = await clusters();
    expect(rows.map((r) => [r.id, r.label, r.label_source])).toEqual([[before!.id, "Mine", "user"]]);
  });

  async function renameToUser(id: string, label: string): Promise<void> {
    await db.query("UPDATE topic_clusters SET label = $2, label_source = 'user' WHERE id = $1", [id, label]);
  }
  /** What the reword path does: the original is archived and keeps its cluster_id; the replacement starts unassigned and embedded. */
  async function reword(id: string, k: number, g = 0): Promise<string> {
    const replacement = await addPrompt(`Reworded ${String(k)}: ${TOPICS[g]!(50 + k)}`, member(g, 50 + k));
    await db.query("UPDATE tracked_prompts SET status = 'archived', superseded_by = $2 WHERE id = $1", [id, replacement]);
    return replacement;
  }

  it("AC3 - a renamed 2-prompt cluster whose BOTH prompts are reworded keeps its id, its user label and its count", async () => {
    const ids = (await seedGroups(1, 2))[0]!;
    await run();
    const [before] = await clusters();
    await renameToUser(before!.id, "Our enterprise CRM");
    for (const [k, id] of ids.entries()) await reword(id, k);
    await run();
    const rows = await clusters();
    expect(rows.map((r) => [r.id, r.label, r.label_source, r.prompt_count])).toEqual([[before!.id, "Our enterprise CRM", "user", 2]]);
  });

  it("AC3 - a renamed 5-prompt cluster whose five prompts are ALL reworded keeps its id and its user label", async () => {
    const ids = (await seedGroups(1, 5))[0]!;
    await run();
    const [before] = await clusters();
    await renameToUser(before!.id, "Our enterprise CRM");
    for (const [k, id] of ids.entries()) await reword(id, k);
    await run();
    const rows = await clusters();
    expect(rows.map((r) => [r.id, r.label, r.label_source, r.prompt_count])).toEqual([[before!.id, "Our enterprise CRM", "user", 5]]);
    expect(await orphans()).toBe(0);
  });

  it("AC3 - a reword of a reword (A -> A' -> A'') still resolves to the original's cluster", async () => {
    const ids = (await seedGroups(1, 2))[0]!;
    await run();
    const [before] = await clusters();
    await renameToUser(before!.id, "Mine");
    for (const [k, id] of ids.entries()) {
      const first = await reword(id, k);
      await reword(first, k + 10);
    }
    await run();
    const rows = await clusters();
    expect(rows.map((r) => [r.id, r.label, r.label_source, r.prompt_count])).toEqual([[before!.id, "Mine", "user", 2]]);
  });

  it("AC3 - members that carry the non-dominant model do not count against an old cluster (a partial re-embed does not dissolve it)", async () => {
    const ids = (await seedGroups(1, 12))[0]!;
    await run();
    const [before] = await clusters();
    await renameToUser(before!.id, "Mine");
    await db.query("UPDATE tracked_prompts SET embedding_model = 'other-model-1536' WHERE id = ANY($1::uuid[])", [ids.slice(0, 8)]);
    for (let k = 0; k < 5; k += 1) await addPrompt(`Another way ${TOPICS[0]!(20 + k)}`, member(0, 20 + k));
    await run();
    const rows = await clusters();
    expect(rows.map((r) => [r.id, r.label, r.label_source])).toEqual([[before!.id, "Mine", "user"]]);
  });

  it("AC3 - a label a user chose between prepare and commit that equals a freshly chosen label does not fail the run", async () => {
    await seedGroups(2, 3);
    await run();
    // A third topic appears. While its label is being chosen, the user renames an existing cluster to the very label the labeller returns.
    for (let i = 0; i < 3; i += 1) await addPrompt(TOPICS[2]!(i), member(2, i));
    const racing = new StubLabeller(async () => {
      await db.query("UPDATE topic_clusters SET label = 'Security & compliance', label_source = 'user' WHERE project_id = $1 AND label = 'Pricing comparison'", [projectId]);
    });
    await run(handler(racing));
    const rows = await clusters();
    expect(rows.map((r) => r.label).sort()).toEqual(["Enterprise CRM", "Security & compliance", "Security & compliance (2)"]);
    expect(rows.find((r) => r.label === "Security & compliance")?.label_source).toBe("user");
  });

  it("AC3 - a label that collided in the run phase is not suffixed twice when the commit finds the suffixed name taken too", async () => {
    await seedGroups(1, 3);
    const same = new StubLabeller();
    same.label = () => Promise.resolve("Same");
    await run(handler(same));
    for (let i = 0; i < 3; i += 1) await addPrompt(TOPICS[1]!(i), member(1, i));
    const [first] = await clusters();
    const racing: TopicLabeller = {
      label: async () => {
        await renameToUser(first!.id, "Same (2)");
        return "Same";
      },
    };
    await run(handler(racing));
    expect((await clusters()).map((r) => r.label).sort()).toEqual(["Same", "Same (2)"]);
  });

  it("AC3 - the label recheck locks the kept rows: a rename in flight is waited for, not raced into the unique index", async () => {
    await seedGroups(2, 3);
    await run();
    for (let i = 0; i < 3; i += 1) await addPrompt(TOPICS[2]!(i), member(2, i));
    const renamer = new Client({ connectionString: container.getConnectionUri() });
    await renamer.connect();
    try {
      // The rename is open (uncommitted) when the commit phase reads the kept labels; it commits only after the run has had time to hit it.
      await renamer.query("BEGIN");
      await renamer.query("UPDATE topic_clusters SET label = 'Security & compliance', label_source = 'user' WHERE project_id = $1 AND label = 'Pricing comparison'", [projectId]);
      let finished = false;
      const running = run(handler()).finally(() => {
        finished = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(finished).toBe(false);
      await renamer.query("COMMIT");
      await running;
    } finally {
      await renamer.end();
    }
    expect((await clusters()).map((r) => r.label).sort()).toEqual(["Enterprise CRM", "Security & compliance", "Security & compliance (2)"]);
  });

  it("AC5 - a prompt set that changes and changes back during a run is not mistaken for 'another run did this': the prompt is still assigned", async () => {
    // Job A snapshots P0 = {a,b,c,d,x}. While it names the group, x is paused, job B clusters {a,b,c,d}, and x is un-paused: P0 again,
    // but the cluster state is B's. A must plan again under the lock, not write nothing.
    const [a, b, c, d, x] = (await seedGroups(1, 5))[0]! as [string, string, string, string, string];
    let raced = false;
    const racing = new StubLabeller(async () => {
      if (raced) return;
      raced = true;
      await db.query("UPDATE tracked_prompts SET status = 'paused' WHERE id = $1", [x]);
      await run(handler(new StubLabeller()));
      await db.query("UPDATE tracked_prompts SET status = 'active' WHERE id = $1", [x]);
    });
    await run(handler(racing));
    const rows = await clusters();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.prompt_count).toBe(5);
    const assigned = await assignments();
    expect(new Set([a, b, c, d, x].map((id) => assigned.get(id)))).toEqual(new Set([rows[0]!.id]));
    expect(await orphans()).toBe(0);
  });

  it("AC7 - the membership write itself refuses a prompt that stopped being clusterable after the plan was made", async () => {
    const [a, b, c] = (await seedGroups(1, 3))[0]! as [string, string, string];
    // New cluster: c is paused between the lock re-check and the write.
    await db.query("UPDATE tracked_prompts SET status = 'paused' WHERE id = $1", [c]);
    const clusterId = randomUUID();
    await writeClusters(db, workspaceId, projectId, MODEL, [{ clusterId, memberIds: [a, b, c], newLabel: "T" }]);
    let assigned = await assignments();
    expect(assigned.get(c)).toBeNull();
    expect(assigned.get(a)).toBe(clusterId);
    expect((await clusters())[0]!.prompt_count).toBe(2);
    // Kept cluster: d was a member, is soft-deleted after the plan, and the plan still lists it. It is let go and not counted.
    const d = await addPrompt(TOPICS[0]!(8), member(0, 8));
    await writeClusters(db, workspaceId, projectId, MODEL, [{ clusterId, memberIds: [a, b, d] }]);
    expect((await clusters())[0]!.prompt_count).toBe(3);
    await db.query("UPDATE tracked_prompts SET deleted_at = now() WHERE id = $1", [d]);
    await writeClusters(db, workspaceId, projectId, MODEL, [{ clusterId, memberIds: [a, b, d] }]);
    assigned = await assignments();
    expect(assigned.get(d)).toBeNull();
    expect((await clusters())[0]!.prompt_count).toBe(2);
  });

  it("AC7 - a planned cluster left with fewer than two clusterable members is not written: no empty cluster, no stale count", async () => {
    const [a, b, c] = (await seedGroups(1, 3))[0]! as [string, string, string];
    // Every planned member stopped being clusterable after the plan: a NEW cluster must not be written at all.
    await db.query("UPDATE tracked_prompts SET status = 'paused' WHERE id = ANY($1::uuid[])", [[a, b, c]]);
    const gone = randomUUID();
    await writeClusters(db, workspaceId, projectId, MODEL, [{ clusterId: gone, memberIds: [a, b, c], newLabel: "T" }]);
    expect(await clusters()).toHaveLength(0);
    // A KEPT cluster that loses all but one member is removed, and the lone member is released rather than left pointing at it.
    await db.query("UPDATE tracked_prompts SET status = 'active' WHERE id = ANY($1::uuid[])", [[a, b, c]]);
    const kept = randomUUID();
    await writeClusters(db, workspaceId, projectId, MODEL, [{ clusterId: kept, memberIds: [a, b, c], newLabel: "T" }]);
    expect((await clusters())[0]!.prompt_count).toBe(3);
    await db.query("UPDATE tracked_prompts SET status = 'paused' WHERE id = ANY($1::uuid[])", [[b, c]]);
    await writeClusters(db, workspaceId, projectId, MODEL, [{ clusterId: kept, memberIds: [a, b, c] }]);
    expect(await clusters()).toHaveLength(0);
    expect([...(await assignments()).values()].every((cluster) => cluster === null)).toBe(true);
    expect(await orphans()).toBe(0);
  });

  it("observability - the label counters and the committed log count the labels that were WRITTEN, not the ones a discarded plan chose", async () => {
    // The A/B/A race: A named its group (one model label), but B's run committed first, so A re-plans onto B's cluster and writes no label.
    const [, , , , x] = (await seedGroups(1, 5))[0]! as [string, string, string, string, string];
    let raced = false;
    const racing = new StubLabeller(async () => {
      if (raced) return;
      raced = true;
      await db.query("UPDATE tracked_prompts SET status = 'paused' WHERE id = $1", [x]);
      await run(handler(new StubLabeller()));
      await db.query("UPDATE tracked_prompts SET status = 'active' WHERE id = $1", [x]);
    });
    counters.length = 0;
    await run(handler(racing));
    expect(counters.filter((c) => c.name === "nominara_topic_cluster_labels_total" && c.labels.source === "model")).toHaveLength(1);
    expect(counters.filter((c) => c.name === "nominara_topic_cluster_runs_total" && c.labels.outcome === "replanned")).toHaveLength(1);
  });

  it("AC3 - a re-plan reuses the label already chosen for a group with the same members instead of discarding it", async () => {
    // The cluster state moves during the run (an unrelated, memberless row appears) but the prompt set does not, so the commit plans
    // again. The group is still unmatched and has the same members: the label the run chose for it is the one written, and it counts once.
    await seedGroups(1, 4);
    let raced = false;
    const racing = new StubLabeller(async () => {
      if (raced) return;
      raced = true;
      await db.query("INSERT INTO topic_clusters (id, workspace_id, project_id, label, label_source) VALUES ($1, $2, $3, 'Unrelated', 'auto')", [randomUUID(), workspaceId, projectId]);
    });
    counters.length = 0;
    await run(handler(racing));
    expect((await clusters()).map((r) => r.label)).toEqual(["Enterprise CRM"]);
    expect(counters.filter((c) => c.name === "nominara_topic_cluster_runs_total" && c.labels.outcome === "replanned")).toHaveLength(1);
    expect(counters.filter((c) => c.name === "nominara_topic_cluster_labels_total").map((c) => c.labels.source)).toEqual(["model"]);
  });

  // ---- AC5, scenario 4 ------------------------------------------------------------------------------------------------

  it("AC5 / scenario 4 - the recomputation waits on the per-project advisory lock", async () => {
    await seedGroups(2, 3);
    const holder = await pool.connect();
    await holder.query("BEGIN");
    await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [projectQueueLockKey("topic.cluster", projectId)]);
    let finished = false;
    const running = run().then(() => {
      finished = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(finished).toBe(false);
    expect(await clusters()).toHaveLength(0);
    await holder.query("COMMIT");
    holder.release();
    await running;
    expect(await clusters()).toHaveLength(2);
  });

  it("AC5 / scenario 4 - two triggers at once leave one consistent set: no duplicate clusters, no orphaned assignment", async () => {
    await seedGroups(3, 4);
    await Promise.all([run(), run()]);
    const rows = await clusters();
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.prompt_count === 4)).toBe(true);
    expect(await orphans()).toBe(0);
    const a = await assignments();
    expect([...a.values()].every((v) => v !== null)).toBe(true);
  });

  it("AC5 - a different project is not blocked by this project's lock", async () => {
    await seedGroups(1, 3);
    const [ws2, p2] = await newProject();
    for (let i = 0; i < 3; i += 1) await addPrompt(TOPICS[0]!(i), member(0, i), { ws: ws2, project: p2 });
    const holder = await pool.connect();
    await holder.query("BEGIN");
    await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [projectQueueLockKey("topic.cluster", projectId)]);
    await run(handler(), job(p2, ws2));
    await holder.query("COMMIT");
    holder.release();
    const r = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM topic_clusters WHERE project_id = $1", [p2]);
    expect(r.rows[0]!.n).toBe("1");
  });

  it("AC5 - a prompt set that changes between the read and the write is refused for retry, not written stale", async () => {
    await seedGroups(2, 3);
    let added = false;
    const racing = new StubLabeller(async () => {
      if (added) return;
      added = true;
      await addPrompt(TOPICS[0]!(7), member(0, 7));
    });
    await expect(run(handler(racing))).rejects.toThrow(/prompt set changed/i);
    expect(await clusters()).toHaveLength(0);
    // The retry sees the settled set and succeeds.
    await run();
    expect((await clusters()).reduce((n, c) => n + c.prompt_count, 0)).toBe(7);
  });

  // ---- AC6, scenario 5 -----------------------------------------------------------------------------------------------

  it("AC6 / scenario 5 - commercial intent is the mean funnel weight of the members (decision 1.0, consideration 0.7, awareness 0.4)", async () => {
    await addPrompt(TOPICS[0]!(0), member(0, 0), { funnel: "decision" });
    await addPrompt(TOPICS[0]!(1), member(0, 1), { funnel: "decision" });
    await addPrompt(TOPICS[0]!(2), member(0, 2), { funnel: "awareness" });
    await addPrompt(TOPICS[1]!(0), member(1, 0), { funnel: "awareness" });
    await addPrompt(TOPICS[1]!(1), member(1, 1), { funnel: "awareness" });
    await addPrompt(TOPICS[2]!(0), member(2, 0), { funnel: "consideration" });
    await addPrompt(TOPICS[2]!(1), member(2, 1), { funnel: "consideration" });
    await run();
    const byLabel = new Map((await clusters()).map((c) => [c.label, c.commercial_intent]));
    expect(byLabel.get("Enterprise CRM")).toBeCloseTo((1 + 1 + 0.4) / 3, 5);
    expect(byLabel.get("Pricing comparison")).toBeCloseTo(0.4, 5);
    expect(byLabel.get("Security & compliance")).toBeCloseTo(0.7, 5);
  });

  // ---- review round 1 ---------------------------------------------------------------------------------------------------

  it("AC1 review - prompts that fit a cluster but fall past the per-project cap are COUNTED as dropped, not mistaken for outliers", async () => {
    await seedGroups(3, 3); // three real groups of 3
    await addPrompt("a lone outlier", vec({ 400: 1 }));
    // The owner connection: this reads the snapshot directly, so RLS has no tenant context to scope it by.
    const under = await snapshotClusters(db, projectId, 2);
    expect(under.groups).toHaveLength(2);
    expect(under.droppedByCap).toBe(3); // the third group's three members: groupable, left out by the cap alone
    const roomy = await snapshotClusters(db, projectId);
    expect(roomy.groups).toHaveLength(3);
    expect(roomy.droppedByCap).toBe(0); // the outlier has no neighbour, so it is an outlier, not a casualty of the cap
  });

  it("AC5 review - editing a member's funnel stage in place changes the prompt-set hash (commercial_intent cannot silently go stale)", async () => {
    const [ids] = await seedGroups(1, 3, "consideration");
    const before = await promptSetHash(db, projectId, MODEL);
    await db.query("UPDATE tracked_prompts SET funnel_stage = 'decision' WHERE id = $1", [ids![0]]);
    const after = await promptSetHash(db, projectId, MODEL);
    expect(after.hash).not.toBe(before.hash);
    expect(after.clusterable).toBe(before.clusterable);
  });

  // ---- AC7, scenario 6 -----------------------------------------------------------------------------------------------

  it("AC7 / scenario 6 - every assignment points at an existing cluster, after the first run and after the set shrinks", async () => {
    await seedGroups(3, 3);
    await run();
    expect(await orphans()).toBe(0);
    // Dissolve one topic entirely and thin another to a single member.
    await db.query("UPDATE tracked_prompts SET deleted_at = now() WHERE text LIKE '%pricing%'");
    await db.query("UPDATE tracked_prompts SET status = 'paused' WHERE id IN (SELECT id FROM tracked_prompts WHERE text LIKE '%SOC 2%' LIMIT 2)");
    await run();
    expect(await orphans()).toBe(0);
    const rows = await clusters();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.label).toBe("Enterprise CRM");
    // The departed prompts hold no cluster.
    const a = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM tracked_prompts WHERE project_id = $1 AND cluster_id IS NOT NULL AND (deleted_at IS NOT NULL OR status <> 'active')", [projectId]);
    expect(a.rows[0]!.n).toBe("0");
  });

  it("AC7 - cluster rows and membership are one transaction: a failure while assigning members leaves no cluster row behind", async () => {
    await seedGroups(2, 3);
    await db.query(`CREATE OR REPLACE FUNCTION fail_assign() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'assign failed'; END; $$`);
    await db.query("CREATE TRIGGER fail_assign BEFORE UPDATE OF cluster_id ON tracked_prompts FOR EACH ROW WHEN (NEW.cluster_id IS NOT NULL) EXECUTE FUNCTION fail_assign()");
    try {
      await expect(run()).rejects.toThrow();
    } finally {
      await db.query("DROP TRIGGER fail_assign ON tracked_prompts");
    }
    expect(await clusters()).toHaveLength(0);
    expect([...(await assignments()).values()].every((v) => v === null)).toBe(true);
  });

  // ---- AC8, scenario 7 -----------------------------------------------------------------------------------------------

  it("AC8 / scenario 7 - a prompt unlike any other is left unassigned, and so is one below the floor of the nearest cluster", async () => {
    const [group] = await seedGroups(1, 3);
    await addPrompt(TOPICS[1]!(0), member(1, 0));
    await addPrompt(TOPICS[1]!(1), member(1, 1));
    const alone = await addPrompt("Totally unrelated question about gardening tools", vec({ 900: 1 }));
    // cosine to group 0 is 0.6 / sqrt(1.09) ~ 0.57: the nearest cluster, but below 0.82.
    const near = await addPrompt("A loosely related CRM question", vec({ 0: 0.6, 901: 0.8 }));
    await run();
    const a = await assignments();
    expect(a.get(alone)).toBeNull();
    expect(a.get(near)).toBeNull();
    expect(a.get(group![0]!)).not.toBeNull();
    const rows = await clusters();
    expect(rows.map((r) => r.prompt_count).sort()).toEqual([2, 3]);
    expect(rows.reduce((n, c) => n + c.prompt_count, 0)).toBe(5);
  });

  it("AC8 - the floor is inclusive-safe: a pair at cosine just under 0.82 does not cluster, a pair just over does", async () => {
    // cos = 1 / sqrt(1 + t^2). t = 0.7 -> 0.819 (under), t = 0.69 -> 0.822 (over).
    const under = (axis: number) => [vec({ [axis]: 1 }), vec({ [axis]: 1, [axis + 1]: 0.7 })];
    const over = (axis: number) => [vec({ [axis]: 1 }), vec({ [axis]: 1, [axis + 1]: 0.69 })];
    const [u0, u1] = under(300);
    const [o0, o1] = over(400);
    const idU0 = await addPrompt("under a", u0!);
    const idU1 = await addPrompt("under b", u1!);
    const idO0 = await addPrompt("over a", o0!);
    const idO1 = await addPrompt("over b", o1!);
    await run();
    const a = await assignments();
    expect(a.get(idU0)).toBeNull();
    expect(a.get(idU1)).toBeNull();
    expect(a.get(idO0)).not.toBeNull();
    expect(a.get(idO0)).toBe(a.get(idO1));
  });

  it("AC8 - a lone prompt never makes a cluster of one; the project then has no clusters", async () => {
    await addPrompt("only prompt", member(0, 0));
    await run();
    expect(await clusters()).toHaveLength(0);
  });

  it("an empty project (no prompts) is a clean no-op", async () => {
    await run();
    expect(await clusters()).toHaveLength(0);
  });

  it("prompts without an embedding, paused prompts and deleted prompts are not clustered", async () => {
    const a = await addPrompt(TOPICS[0]!(0), member(0, 0));
    await addPrompt(TOPICS[0]!(1), member(0, 1));
    await addPrompt(TOPICS[0]!(2), null);
    await addPrompt(TOPICS[0]!(3), member(0, 3), { status: "paused" });
    await addPrompt(TOPICS[0]!(4), member(0, 4), { deleted: true });
    await run();
    const rows = await clusters();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.prompt_count).toBe(2);
    expect((await assignments()).get(a)).not.toBeNull();
  });

  it("EC-23 - prompts embedded by two models are never compared: only the dominant model is clustered", async () => {
    for (let i = 0; i < 3; i += 1) await addPrompt(TOPICS[0]!(i), member(0, i), { model: "model-a" });
    const stray = await addPrompt(TOPICS[0]!(8), member(0, 8), { model: "model-b" });
    await run();
    const rows = await clusters();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.embedding_model).toBe("model-a");
    expect(rows[0]!.prompt_count).toBe(3);
    expect((await assignments()).get(stray)).toBeNull();
  });

  // ---- idempotence, tenancy ---------------------------------------------------------------------------------------------

  it("NFR-ARCH-02 - a redelivered job over an unchanged set rewrites the same clusters (same ids, same counts)", async () => {
    await seedGroups(3, 3);
    await run();
    const first = await clusters();
    const assigned = await assignments();
    await run();
    expect(await clusters()).toEqual(first);
    expect(await assignments()).toEqual(assigned);
  });

  it("preservation (NOT AC9 coverage; AC9 is open) - recomputation keeps a cluster's denormalised performance columns instead of clearing them", async () => {
    await seedGroups(2, 3);
    await run();
    await db.query("UPDATE topic_clusters SET visibility_score = 42.5, gap_priority = 0.3 WHERE project_id = $1", [projectId]);
    await addPrompt(TOPICS[0]!(9), member(0, 9));
    await run();
    const rows = await clusters();
    expect(rows.every((r) => r.visibility_score === "42.500")).toBe(true);
  });

  it("tenancy - a job signed for workspace A that names workspace B's project clusters nothing of B's", async () => {
    const [wsB, projB] = await newProject();
    for (let i = 0; i < 3; i += 1) await addPrompt(TOPICS[0]!(i), member(0, i), { ws: wsB, project: projB });
    await run(handler(), job(projB, workspaceId));
    const r = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM topic_clusters");
    expect(r.rows[0]!.n).toBe("0");
    const p = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM tracked_prompts WHERE project_id = $1 AND cluster_id IS NOT NULL", [projB]);
    expect(p.rows[0]!.n).toBe("0");
  });

  it("tenancy - identically embedded prompts in two workspaces: A's run groups, samples and writes only A's rows", async () => {
    await seedGroups(1, 3);
    const [wsB, projB] = await newProject();
    const bIds: string[] = [];
    for (let i = 0; i < 3; i += 1) bIds.push(await addPrompt(`B-ONLY secret ${String(i)}`, member(0, i), { ws: wsB, project: projB }));
    const seen: string[] = [];
    await run(handler({ label: (request) => { seen.push(...request.prompts); return Promise.resolve("Enterprise CRM"); } }));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.some((text) => text.includes("B-ONLY"))).toBe(false);
    expect(await clusters()).toHaveLength(1);
    const b = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM tracked_prompts WHERE id = ANY($1::uuid[]) AND cluster_id IS NOT NULL", [bIds]);
    expect(b.rows[0]!.n).toBe("0");
    expect((await db.query("SELECT 1 FROM topic_clusters WHERE project_id = $1", [projB])).rowCount).toBe(0);
  });

  it("tenancy - clustering one project never touches another project's clusters or assignments in the same workspace", async () => {
    await seedGroups(2, 3);
    const p2 = randomUUID();
    await db.query(`INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain) VALUES ($1, $2, 'Q', $3, 'https://q.test', 'q.test')`, [p2, workspaceId, `q-${randomUUID().slice(0, 8)}`]);
    for (let i = 0; i < 3; i += 1) await addPrompt(TOPICS[0]!(i), member(0, i), { project: p2 });
    await run(handler(), job(p2));
    const mine = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM tracked_prompts WHERE project_id = $1 AND cluster_id IS NOT NULL", [projectId]);
    expect(mine.rows[0]!.n).toBe("0");
    expect((await db.query("SELECT 1 FROM topic_clusters WHERE project_id = $1", [p2])).rowCount).toBe(1);
  });

  // ---- AC4: the triggers -----------------------------------------------------------------------------------------------

  describe("AC4 / scenario 3 - triggers", () => {
    const now = new Date();
    async function due() {
      return (await findProjectsDueForClustering(db, now)).filter((d) => d.projectId === projectId);
    }

    it("a project with clusterable prompts and no clusters yet is due (initial)", async () => {
      await seedGroups(1, 3);
      const [d] = await due();
      expect(d?.reason).toBe("initial");
      expect(d?.workspaceId).toBe(workspaceId);
    });

    it("a project with fewer than two clusterable prompts is not due", async () => {
      await addPrompt("lonely", member(0, 0));
      expect(await due()).toHaveLength(0);
    });

    it("scenario 3 - adding prompts past 10% of the set triggers recomputation; below it does not", async () => {
      await seedGroups(2, 10); // 20 prompts, clustered
      await run();
      expect(await due()).toHaveLength(0);
      await addPrompt(TOPICS[0]!(50), member(0, 15)); // 1 of 21 = 4.8%
      expect(await due()).toHaveLength(0);
      await addPrompt(TOPICS[1]!(51), member(1, 15)); // 2 of 22 = 9.1%
      expect(await due()).toHaveLength(0);
      await addPrompt(TOPICS[1]!(52), member(1, 16)); // 3 of 23 = 13%
      const [d] = await due();
      expect(d?.reason).toBe("prompt_set_change");
    });

    it("scenario 3 - removing prompts counts toward the same 10%", async () => {
      await seedGroups(2, 10);
      await run();
      await db.query("UPDATE tracked_prompts SET deleted_at = now() WHERE id IN (SELECT id FROM tracked_prompts WHERE cluster_id IS NOT NULL ORDER BY id LIMIT 3)");
      expect((await due())[0]?.reason).toBe("prompt_set_change");
    });

    it("a switch of embedding model is a material change: every clustered prompt re-embedded makes the project due", async () => {
      await seedGroups(2, 3);
      await run();
      expect(await due()).toHaveLength(0);
      await db.query("UPDATE tracked_prompts SET embedding_model = 'other-model-1536' WHERE project_id = $1", [projectId]);
      expect((await due())[0]?.reason).toBe("prompt_set_change");
      await run();
      expect(await due()).toHaveLength(0);
    });

    it("a clustered prompt whose embedding was cleared has left the set and counts toward the 10%", async () => {
      await seedGroups(2, 5);
      await run();
      expect(await due()).toHaveLength(0);
      await db.query("UPDATE tracked_prompts SET embedding = NULL, embedding_model = NULL WHERE id IN (SELECT id FROM tracked_prompts WHERE cluster_id IS NOT NULL ORDER BY id LIMIT 3)");
      expect((await due())[0]?.reason).toBe("prompt_set_change");
    });

    it("the periodic schedule - an unchanged project is due once its clusters are older than seven days, not before", async () => {
      await seedGroups(2, 3);
      await run();
      const age = async (days: number) => {
        // `touch_updated_at` would overwrite the value, so it is switched off for the write that sets it.
        await db.query("ALTER TABLE topic_clusters DISABLE TRIGGER touch_updated_at");
        await db.query("UPDATE topic_clusters SET updated_at = $2 WHERE project_id = $1", [projectId, new Date(now.getTime() - days * 86_400_000)]);
        await db.query("ALTER TABLE topic_clusters ENABLE TRIGGER touch_updated_at");
      };
      await age(6.9);
      expect(await due()).toHaveLength(0);
      await age(7.1);
      expect((await due())[0]?.reason).toBe("weekly");
    });

    it("the sweep enqueues one signed-job request per due project under the topic:{project}:{prompt_set_hash} key, and the key changes with the set", async () => {
      await seedGroups(1, 3);
      const sent: { workspaceId: string; payload: unknown; key: string }[] = [];
      const enqueue = (_q: "topic.cluster", ws: string, payload: Record<string, unknown>, o: { idempotencyKey: string }) => {
        sent.push({ workspaceId: ws, payload, key: o.idempotencyKey });
        return Promise.resolve();
      };
      const first = await runTopicClusterSweep(db, enqueue, now);
      expect(first).toMatchObject({ status: "complete", due: 1, enqueued: 1, failed: 0 });
      expect(sent[0]!.workspaceId).toBe(workspaceId);
      expect(sent[0]!.payload).toEqual({ projectId, reason: "initial" });
      expect(sent[0]!.key).toMatch(new RegExp(`^topic:${projectId}:[0-9a-f]{64}$`));
      await runTopicClusterSweep(db, enqueue, now);
      expect(sent[1]!.key).toBe(sent[0]!.key);
      await addPrompt(TOPICS[0]!(9), member(0, 9));
      await runTopicClusterSweep(db, enqueue, now);
      expect(sent[2]!.key).not.toBe(sent[0]!.key);
    });

    it("a failed enqueue is counted and reported partial, and does not stop the other projects", async () => {
      await seedGroups(1, 3);
      const [ws2, p2] = await newProject();
      for (let i = 0; i < 3; i += 1) await addPrompt(TOPICS[0]!(i), member(0, i), { ws: ws2, project: p2 });
      let calls = 0;
      const enqueue = () => {
        calls += 1;
        return calls === 1 ? Promise.reject(new Error("valkey down")) : Promise.resolve();
      };
      const result = await runTopicClusterSweep(db, enqueue, now);
      expect(result).toMatchObject({ status: "partial", failed: 1, enqueued: 1 });
    });

    it("the sweep refuses a connection that cannot see across tenants (it would find nothing and look healthy)", async () => {
      const app = await pool.connect();
      try {
        await expect(runTopicClusterSweep(app, () => Promise.resolve(), now)).rejects.toThrow(/row-level security/i);
      } finally {
        app.release();
      }
    });
  });

  // ---- the pipeline with the stand-in provider --------------------------------------------------------------------------

  it("pipeline - prompts embedded by embed.batch (stand-in provider) cluster; this proves the wiring, not the model", async () => {
    const family = (word: string) => [0, 1, 2].map((i) => `how should a buyer evaluate ${word} platform security and compliance for large enterprise teams option ${String(i)}`);
    const ids: string[] = [];
    for (const text of [...family("analytics"), ...family("billing").map((t) => t.replace(/security and compliance for large enterprise teams/, "invoicing"))]) {
      ids.push(await addPrompt(text, null));
    }
    const embedContext = { pool: undefined, env: { NODE_ENV: "test" } } as unknown as QueueHandlerContext;
    const embed = createEmbedBatchHandler(embedContext, { provider: new StandInEmbeddingProvider() });
    const embedEntry = QUEUE_TOPOLOGY.find((e) => e.name === "embed.batch")!;
    const payload = { workspaceId, kid: "k1", table: "tracked_prompts", ids };
    const process = createJobProcessor(embedEntry, { keys: KEYS, getClient: () => pool.connect(), releaseClient: (c) => (c as PoolClient).release(), process: embed });
    await process({ data: signQueueJobPayload(payload, KEYS.current.key) } as unknown as Job);
    await run();
    const rows = await clusters();
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((r) => r.embedding_model === STAND_IN_EMBEDDING_MODEL)).toBe(true);
    expect(await orphans()).toBe(0);
  });

  void createHash;
});
