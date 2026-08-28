import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import {
  L2_COSINE_THRESHOLD,
  cellKey,
  probeSemanticReuse,
  type L2Candidate,
} from "../../src/lib/capture/l2-semantic-reuse.js";

// STORY-032 — tracking-engine.md §6's L2 admission rules, against real
// Postgres and real pgvector.
//
// Six rules, and a test for each REFUSAL, because every one of them is a
// distinct way to admit a reuse that should not be admitted — and an
// over-admitting probe is invisible from the outside. The cell still produces
// a row, the matrix still looks full, and the number is quietly derived from
// the wrong capture. Nothing fails; the chart is just wrong.
//
// The embeddings here are hand-built unit vectors rather than model output,
// so "cosine 0.99" and "cosine 0.5" are exact rather than approximate. That
// is what lets the threshold test assert a boundary instead of a vibe.
const TTL_SECONDS = 86_400;

/** A 1536-d unit vector leaning on axis `a`, mixed with axis `b` by `mix`. */
function embedding(a: number, b: number, mix: number): string {
  const v = new Array<number>(1536).fill(0);
  const norm = Math.sqrt(1 + mix * mix);
  v[a] = 1 / norm;
  v[b] = mix / norm;
  return `[${v.join(",")}]`;
}

describe("STORY-032 · L2 semantic reuse — the six admission rules", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
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
  }, 240_000);

  afterAll(async () => {
    await db.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.query("TRUNCATE answer_captures, tracked_prompts, capture_runs, projects, workspaces CASCADE");
    workspaceId = randomUUID();
    projectId = randomUUID();
    await db.query("INSERT INTO workspaces (id, name, slug, plan_key) VALUES ($1, $2, $3, 'free')", [
      workspaceId,
      "L2",
      `l2-${randomUUID().slice(0, 8)}`,
    ]);
    await db.query(
      `INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain)
       VALUES ($1, $2, 'P', $3, 'https://example.test', 'example.test')`,
      [projectId, workspaceId, `p-${randomUUID().slice(0, 8)}`],
    );
  });

  async function addPrompt(text: string, vector: string, project = projectId): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO tracked_prompts (id, workspace_id, project_id, text, text_hash, intent_archetype, funnel_stage, embedding)
       VALUES ($1, $2, $3, $4, sha256($5::bytea), 'recommendation', 'consideration', $6::halfvec)`,
      // $4 and $5 are the same string, bound twice: reusing one placeholder
      // as both `text` and `bytea` leaves Postgres unable to deduce its type.
      [id, workspaceId, project, text, Buffer.from(text, "utf8"), vector],
    );
    return id;
  }

  interface SourceOptions {
    readonly engineKey?: string;
    readonly status?: string;
    readonly cacheLayer?: string;
    readonly ageSeconds?: number;
    readonly project?: string;
  }

  async function addSourceCapture(promptId: string, options: SourceOptions = {}): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO answer_captures
         (id, workspace_id, project_id, run_id, prompt_id, engine_key, captured_at,
          capture_mode, adapter_version, normalizer_version, content_hash, status, cache_layer)
       VALUES ($1, $2, $3, $4, $5, $6, now() - make_interval(secs => $7),
               'api', '1.0.0', 'v1', sha256('x'::bytea), $8, $9)`,
      [
        id,
        workspaceId,
        options.project ?? projectId,
        randomUUID(),
        promptId,
        options.engineKey ?? "perplexity",
        options.ageSeconds ?? 60,
        options.status ?? "parsed",
        options.cacheLayer ?? "live",
      ],
    );
    return id;
  }

  function candidate(promptId: string, engineKey = "perplexity"): L2Candidate {
    return { promptId, engineKey, sampleIndex: 0, ttlSeconds: TTL_SECONDS };
  }

  /** A near-duplicate pair: target and source almost parallel, cosine ~0.995. */
  async function nearDuplicatePair(): Promise<{ target: string; source: string }> {
    const source = await addPrompt("best crm for small business", embedding(0, 1, 0.0));
    const target = await addPrompt("best crm for small businesses", embedding(0, 1, 0.1));
    return { target, source };
  }

  // The guard on every refusal below: if the probe admitted NOTHING, every
  // "must not reuse" test would pass for the wrong reason.
  it("admits a genuine near-duplicate", async () => {
    const { target, source } = await nearDuplicatePair();
    const sourceId = await addSourceCapture(source);

    const hits = await probeSemanticReuse(db, projectId, [candidate(target)]);

    expect(hits.size, "the probe must be capable of admitting at all").toBe(1);
    expect(hits.get(cellKey(candidate(target)))?.sourceResultId).toBe(sourceId);
    expect(hits.get(cellKey(candidate(target)))!.cosine).toBeGreaterThanOrEqual(L2_COSINE_THRESHOLD);
  }, 30_000);

  it("rule 1 — refuses a source from ANOTHER project, even in the same workspace", async () => {
    const otherProject = randomUUID();
    await db.query(
      `INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain)
       VALUES ($1, $2, 'Other', $3, 'https://other.test', 'other.test')`,
      [otherProject, workspaceId, `o-${randomUUID().slice(0, 8)}`],
    );
    const source = await addPrompt("best crm for small business", embedding(0, 1, 0.0), otherProject);
    const target = await addPrompt("best crm for small businesses", embedding(0, 1, 0.1));
    await addSourceCapture(source, { project: otherProject });

    expect((await probeSemanticReuse(db, projectId, [candidate(target)])).size).toBe(0);
  }, 30_000);

  it("rule 2 — refuses a source captured from a DIFFERENT engine", async () => {
    const { target, source } = await nearDuplicatePair();
    await addSourceCapture(source, { engineKey: "chatgpt" });

    expect((await probeSemanticReuse(db, projectId, [candidate(target, "perplexity")])).size).toBe(0);
  }, 30_000);

  // The boundary, from both sides. A threshold asserted only from the passing
  // side would hold for any value at or below 0.94.
  it("rule 3 — refuses below the cosine threshold and admits at it", async () => {
    const source = await addPrompt("best crm", embedding(0, 1, 0.0));
    const farTarget = await addPrompt("weather tomorrow", embedding(0, 1, 1.0)); // cosine ~0.707
    await addSourceCapture(source);

    expect((await probeSemanticReuse(db, projectId, [candidate(farTarget)])).size, "0.707 is below 0.94").toBe(0);

    const nearTarget = await addPrompt("best crms", embedding(0, 1, 0.2)); // cosine ~0.98
    expect((await probeSemanticReuse(db, projectId, [candidate(nearTarget)])).size, "0.98 is above 0.94").toBe(1);
  }, 30_000);

  it("rule 4 — refuses a source older than half the engine's TTL", async () => {
    const { target, source } = await nearDuplicatePair();
    // 0.6 x TTL: inside the full TTL, outside the half-TTL reuse window.
    await addSourceCapture(source, { ageSeconds: TTL_SECONDS * 0.6 });

    expect((await probeSemanticReuse(db, projectId, [candidate(target)])).size).toBe(0);
  }, 30_000);

  it("rule 5 — refuses a source that is not fully parsed", async () => {
    const { target, source } = await nearDuplicatePair();
    await addSourceCapture(source, { status: "captured" });

    expect((await probeSemanticReuse(db, projectId, [candidate(target)])).size).toBe(0);
  }, 30_000);

  // §6's no-transitive-chains rule, and the one whose absence would be
  // slowest to notice: a reuse of a reuse of a reuse drifts arbitrarily far
  // from a real capture, and nothing in the row reveals how far.
  it("rule 6 — refuses a source that is ITSELF an L2 reuse, so chains cannot form", async () => {
    const { target, source } = await nearDuplicatePair();
    await addSourceCapture(source, { cacheLayer: "l2" });

    expect((await probeSemanticReuse(db, projectId, [candidate(target)])).size).toBe(0);
  }, 30_000);

  // AC5 — one query for the whole batch, not one per cell. Asserted by
  // counting round trips rather than by reading the source, because the
  // property is about cost at scale and a loop would look correct.
  it("probes the whole batch in ONE round trip, whatever the run size", async () => {
    const { source } = await nearDuplicatePair();
    await addSourceCapture(source);

    const targets: L2Candidate[] = [];
    for (let i = 0; i < 25; i += 1) {
      targets.push(candidate(await addPrompt(`variant ${String(i)}`, embedding(0, 1, 0.1))));
    }

    let queries = 0;
    const counting = new Proxy(db, {
      get(target, property, receiver) {
        if (property === "query") {
          return (...args: unknown[]) => {
            queries += 1;
            return (target.query as (...a: unknown[]) => unknown)(...args);
          };
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });

    const hits = await probeSemanticReuse(counting, projectId, targets);

    expect(queries, "25 cells must cost one query, or planning scales with run size").toBe(1);
    expect(hits.size, "and it must still find them").toBe(25);
  }, 60_000);

  it("returns nothing, and asks nothing, for an empty batch", async () => {
    let queries = 0;
    const counting = new Proxy(db, {
      get(target, property, receiver) {
        if (property === "query") {
          return (...args: unknown[]) => {
            queries += 1;
            return (target.query as (...a: unknown[]) => unknown)(...args);
          };
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });

    expect((await probeSemanticReuse(counting, projectId, [])).size).toBe(0);
    expect(queries).toBe(0);
  }, 30_000);
});
