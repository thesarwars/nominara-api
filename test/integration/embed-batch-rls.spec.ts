import { createHash, randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { Job } from "bullmq";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { resolveBillingPeriod } from "../../src/lib/usage/billing-period.js";
import { embedBatchPayloadSchema } from "../../src/lib/embedding/embed-batch.js";
import { signQueueJobPayload } from "../../src/lib/queue/envelope.js";
import { createEmbedBatchHandler } from "../../src/lib/queue/handlers/embed-batch.handler.js";
import type { QueueHandlerContext } from "../../src/lib/queue/handlers.js";
import { QUEUE_TOPOLOGY } from "../../src/lib/queue/topology.js";
import { createJobProcessor } from "../../src/lib/queue/worker-factory.js";
import { StandInEmbeddingProvider, STAND_IN_EMBEDDING_MODEL } from "../../src/modules/prompts/adapters/stand-in-embedding-provider.js";
import type { EmbeddingBatchResult, EmbeddingProvider } from "../../src/modules/prompts/ports/embedding-provider.js";

// STORY-133 - embed.batch under the RUNTIME role (`nominara_app`, no BYPASSRLS), through the real `createJobProcessor`.
//
// embed-batch-handler.spec.ts runs as the testcontainers superuser, so every statement there bypasses RLS. That makes two things
// unproven by it, and this file proves them: (1) a signed job for workspace A that NAMES workspace B's rows can neither read,
// embed nor meter them; (2) the usage_ledger / usage_counters writes the handler swallows errors from (`meterTokens` contains a
// failure in a savepoint) actually succeed under the grants and WITH CHECK policies the worker really has. A grant failure there
// would otherwise show up only as `nominara_embed_metering_failed_total`.

const KEYS = { current: { kid: "k1", key: Buffer.from("embed-batch-test-signing-key-32by") } };
const ENTRY = QUEUE_TOPOLOGY.find((entry) => entry.name === "embed.batch")!;

class RecordingProvider implements EmbeddingProvider {
  readonly model = STAND_IN_EMBEDDING_MODEL;
  readonly dimensions = 1536;
  readonly sent: string[] = [];
  private readonly inner = new StandInEmbeddingProvider();
  async embed(texts: readonly string[]): Promise<EmbeddingBatchResult> {
    this.sent.push(...texts);
    return this.inner.embed(texts);
  }
}

describe("STORY-133 · embed.batch under the runtime role (RLS in force)", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let appDb: Client;
  let wsA: string;
  let wsB: string;
  let projA: string;
  let projB: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18").withDatabase("nominara_test").withUsername("nominara").withPassword("nominara").start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await migrateUp(db);
    const password = resolvePassword("nominara_app", {});
    await db.query(`ALTER ROLE nominara_app PASSWORD ${db.escapeLiteral(password)}`);
    appDb = new Client({ host: container.getHost(), port: container.getMappedPort(5432), database: container.getDatabase(), user: "nominara_app", password });
    await appDb.connect();
  }, 300_000);

  afterAll(async () => {
    await appDb.end();
    await db.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.query("TRUNCATE usage_ledger, usage_counters, content_chunks, tracked_prompts, projects, workspaces CASCADE");
    [wsA, wsB, projA, projB] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    for (const [ws, project] of [[wsA, projA], [wsB, projB]] as const) {
      await db.query("INSERT INTO workspaces (id, name, slug, plan_key) VALUES ($1, 'W', $2, 'growth')", [ws, `w-${randomUUID().slice(0, 8)}`]);
      await db.query(
        `INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain) VALUES ($1, $2, 'P', $3, 'https://example.test', 'example.test')`,
        [project, ws, `p-${randomUUID().slice(0, 8)}`],
      );
    }
  });

  async function addPrompt(ws: string, project: string, text: string): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO tracked_prompts (id, workspace_id, project_id, text, text_hash, intent_archetype, funnel_stage, status)
       VALUES ($1, $2, $3, $4, sha256($5::bytea), 'recommendation', 'consideration', 'active')`,
      [id, ws, project, text, Buffer.from(text, "utf8")],
    );
    return id;
  }

  async function addChunk(ws: string, project: string, text: string, embedded: boolean): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO content_chunks (id, workspace_id, project_id, url, chunk_index, text, token_count, content_hash, embedding_model, embedding)
       VALUES ($1, $2, $3, 'https://example.test/a', 0, $4, 10, $5, $6, $7::halfvec)`,
      [
        id, ws, project, text, createHash("sha256").update(text).digest(),
        embedded ? STAND_IN_EMBEDDING_MODEL : null,
        embedded ? `[${["1", ...new Array<string>(1535).fill("0")].join(",")}]` : null,
      ],
    );
    return id;
  }

  /** A job signed for `ws` (whatever ids it names), run through the real processor on the non-BYPASSRLS connection. */
  async function runAs(ws: string, provider: EmbeddingProvider, table: string, ids: string[]): Promise<void> {
    const context = { pool: undefined, env: { NODE_ENV: "test" } } as unknown as QueueHandlerContext;
    const process = createJobProcessor(ENTRY, { keys: KEYS, getClient: () => appDb, process: createEmbedBatchHandler(context, { provider }) });
    const payload = embedBatchPayloadSchema.parse({ workspaceId: ws, kid: "k1", table, ids });
    await process({ data: signQueueJobPayload(payload, KEYS.current.key) } as unknown as Job);
  }

  const state = async (table: string, id: string) =>
    (await db.query<{ has_vector: boolean; embedding_model: string | null }>(`SELECT embedding IS NOT NULL AS has_vector, embedding_model FROM ${table} WHERE id = $1`, [id])).rows[0]!;

  it("tenancy - a job signed for A that names B's prompt leaves B's row untouched, sends only A's text and meters A alone", async () => {
    const aPrompt = await addPrompt(wsA, projA, "workspace a prompt about crm tools");
    const bPrompt = await addPrompt(wsB, projB, "workspace b secret prompt about erp tools");
    const provider = new RecordingProvider();

    await runAs(wsA, provider, "tracked_prompts", [aPrompt, bPrompt]);

    expect(await state("tracked_prompts", aPrompt)).toEqual({ has_vector: true, embedding_model: STAND_IN_EMBEDDING_MODEL });
    expect(await state("tracked_prompts", bPrompt), "B's row is not written").toEqual({ has_vector: false, embedding_model: null });
    expect(provider.sent, "B's text never leaves the database for A's job").toEqual(["workspace a prompt about crm tools"]);
    const ledger = await db.query<{ workspace_id: string }>("SELECT workspace_id FROM usage_ledger WHERE metric = 'embed_tokens'");
    expect(ledger.rows.map((row) => row.workspace_id)).toEqual([wsA]);
  }, 60_000);

  it("tenancy - a job signed for A naming ONLY B's chunk does nothing at all: no provider call, no write, no metering", async () => {
    const bChunk = await addChunk(wsB, projB, "b only chunk text", false);
    const provider = new RecordingProvider();
    await runAs(wsA, provider, "content_chunks", [bChunk]);
    expect(provider.sent).toEqual([]);
    expect((await state("content_chunks", bChunk)).has_vector).toBe(false);
    expect((await db.query("SELECT 1 FROM usage_ledger")).rowCount).toBe(0);
  }, 60_000);

  it("tenancy - L7: B's embedded chunk with the same content_hash is NOT copied into A's chunk; A's text goes to the provider", async () => {
    await addChunk(wsB, projB, "shared boilerplate chunk text", true);
    const aChunk = await addChunk(wsA, projA, "shared boilerplate chunk text", false);
    const provider = new RecordingProvider();

    await runAs(wsA, provider, "content_chunks", [aChunk]);

    expect(provider.sent, "no cross-tenant reuse: A's own text was embedded").toEqual(["shared boilerplate chunk text"]);
    expect(await state("content_chunks", aChunk)).toEqual({ has_vector: true, embedding_model: STAND_IN_EMBEDDING_MODEL });
  }, 60_000);

  it("metering - under the runtime role the usage_ledger row is written and usage_counters is incremented (not swallowed by the savepoint)", async () => {
    const id = await addPrompt(wsA, projA, "a prompt about crm tools for metering");
    // An ABSENT counter row is a no-op by design (embed-batch-handler.spec scenario 14), so seed the row the way billing does.
    const period = await resolveBillingPeriod(db, wsA);
    await db.query(
      `INSERT INTO usage_counters (workspace_id, metric, period_start, limit_value, used_value, billable) VALUES ($1, 'embed_tokens', $2, -1, 0, false)`,
      [wsA, period.start],
    );
    await runAs(wsA, new RecordingProvider(), "tracked_prompts", [id]);

    const ledger = await db.query<{ quantity: string }>("SELECT quantity::text FROM usage_ledger WHERE metric = 'embed_tokens' AND workspace_id = $1", [wsA]);
    expect(ledger.rows).toHaveLength(1);
    expect(Number(ledger.rows[0]!.quantity)).toBeGreaterThan(0);
    const counter = await db.query<{ used_value: string }>("SELECT used_value::text FROM usage_counters WHERE metric = 'embed_tokens' AND workspace_id = $1", [wsA]);
    expect(counter.rows).toHaveLength(1);
    expect(Number(counter.rows[0]!.used_value)).toBe(Number(ledger.rows[0]!.quantity));
  }, 60_000);
});
