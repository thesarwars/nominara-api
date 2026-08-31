import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import {
  L2_COSINE_THRESHOLD,
  L2_WINDOW_FRACTION,
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
  // PINNED AGAINST THE LITERALS. Every other assertion in this file compares
  // a fixture against the imported constant, so it MOVES with the constant:
  // the review set the threshold to 0.80 and the window to 0.3 and all 1399
  // tests stayed green. §6 gives both numbers; these two lines are what make
  // the file notice if they change.
  it("carries §6's two constants exactly", () => {
    expect(L2_COSINE_THRESHOLD).toBe(0.94);
    expect(L2_WINDOW_FRACTION).toBe(0.5);
  });

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
  /**
   * `ux_prompts_project_hash` makes prompt text unique per project, so each
   * call needs its own text — a test that builds two pairs otherwise fails on
   * the fixture rather than on the property.
   */
  async function nearDuplicatePair(): Promise<{ target: string; source: string }> {
    const tag = randomUUID().slice(0, 8);
    const source = await addPrompt(`best crm for small business ${tag}`, embedding(0, 1, 0.0));
    const target = await addPrompt(`best crm for small businesses ${tag}`, embedding(0, 1, 0.1));
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

  // THE OTHER SIDE OF RULE 1, which had no filter at all. The source-side
  // check was present twice; the TARGET prompt was joined on id alone, so a
  // cell whose prompt belonged to another project matched against this
  // project's captures. RLS does not cover it — it holds the WORKSPACE
  // boundary and says nothing about a project boundary inside one. Found by
  // the second-engineer review, reproduced under correct tenant context.
  it("rule 1 — refuses a TARGET prompt from another project in the same workspace", async () => {
    const otherProject = randomUUID();
    await db.query(
      `INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain)
       VALUES ($1, $2, 'Other', $3, 'https://other.test', 'other.test')`,
      [otherProject, workspaceId, `o-${randomUUID().slice(0, 8)}`],
    );
    // The SOURCE is in this project and perfectly admissible; only the target
    // is foreign, which is the case the original test could not see.
    const source = await addPrompt("best crm for small business", embedding(0, 1, 0.0));
    await addSourceCapture(source);
    const foreignTarget = await addPrompt("best crm for small businesses", embedding(0, 1, 0.1), otherProject);

    expect((await probeSemanticReuse(db, projectId, [candidate(foreignTarget)])).size).toBe(0);
  }, 30_000);

  it("rule 2 — refuses a source captured from a DIFFERENT engine", async () => {
    const { target, source } = await nearDuplicatePair();
    await addSourceCapture(source, { engineKey: "chatgpt" });

    expect((await probeSemanticReuse(db, projectId, [candidate(target, "perplexity")])).size).toBe(0);
  }, 30_000);

  // The boundary, from both sides. A threshold asserted only from the passing
  // side would hold for any value at or below 0.94.
  // STRADDLES 0.94 rather than bracketing it loosely. The original fixtures
  // were 0.707 and 0.98, which hold for ANY threshold between them — the
  // review moved the constant to 0.80 and this test did not notice.
  //
  // cos(theta) for embedding(0,1,mix) against embedding(0,1,0) is
  // 1/sqrt(1+mix^2), so mix = sqrt(1/c^2 - 1) puts the pair exactly at c.
  it("rule 3 — refuses just below §6's threshold and admits just above it", async () => {
    const source = await addPrompt("best crm", embedding(0, 1, 0.0));
    await addSourceCapture(source);

    const justBelow = Math.sqrt(1 / 0.935 ** 2 - 1); // cosine ~0.935
    const justAbove = Math.sqrt(1 / 0.945 ** 2 - 1); // cosine ~0.945

    const below = await addPrompt("below", embedding(0, 1, justBelow));
    expect((await probeSemanticReuse(db, projectId, [candidate(below)])).size, "0.935 < 0.94").toBe(0);

    const above = await addPrompt("above", embedding(0, 1, justAbove));
    expect((await probeSemanticReuse(db, projectId, [candidate(above)])).size, "0.945 >= 0.94").toBe(1);
  }, 30_000);

  // Straddles 0.5x TTL. The original pair was 60s and 0.6x, which holds for
  // any fraction in roughly (0.0007, 0.6).
  it("rule 4 — straddles the half-TTL reuse window", async () => {
    const { target, source } = await nearDuplicatePair();
    await addSourceCapture(source, { ageSeconds: TTL_SECONDS * 0.55 });
    expect(
      (await probeSemanticReuse(db, projectId, [candidate(target)])).size,
      "0.55x TTL is outside the 0.5x reuse window",
    ).toBe(0);

    const fresh = await nearDuplicatePair();
    await addSourceCapture(fresh.source, { ageSeconds: TTL_SECONDS * 0.45 });
    expect(
      (await probeSemanticReuse(db, projectId, [candidate(fresh.target)])).size,
      "0.45x TTL is inside it",
    ).toBe(1);
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
