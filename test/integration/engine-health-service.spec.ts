import { Client, Pool } from "pg";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { EngineHealthService } from "../../src/modules/health/engine-health.service.js";

// STORY-031 Phase E — D11 (no migration, no DDL: `engine_health` already
// exists from the STORY-008/030-era migration). Real Postgres per
// testing-strategy.md §1. Proves concurrent upserts accumulate correctly
// via `ON CONFLICT ... DO UPDATE` (never lost, never double-counted), p50/p95
// get written once latency samples exist, and `circuit_state` mirrors the
// latest recorded value.

describe("STORY-031 · EngineHealthService — real-Postgres concurrent upserts", () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let service: EngineHealthService;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();

    const client = new Client({ connectionString: container.getConnectionUri() });
    await client.connect();
    await migrateUp(client);
    await client.end();

    pool = new Pool({ connectionString: container.getConnectionUri() });
    service = new EngineHealthService(pool);

    // ⚠ NO `INSERT INTO engines` HERE ANY MORE. `engine_health.engine_key`
    // FK-references `engines(key)`, and migration 0027 seeds the catalog, so
    // the rows this needs already exist by the time `migrateUp` returns.
    // Re-inserting them is a duplicate-key error, and hand-seeding a row the
    // product ships is how the empty catalog stayed invisible for so long.
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  beforeEach(async () => {
    await pool.query("DELETE FROM engine_health");
  });

  it("50 concurrent attempts for the SAME 5-minute bucket accumulate exactly — no lost updates, no double-counting", async () => {
    const bucketStartMs = Date.UTC(2026, 0, 1, 10, 5, 0, 0);
    const atMs = bucketStartMs + 60_000; // mid-bucket

    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        service.recordAttempt({
          engineKey: "chatgpt",
          atMs,
          outcome: i % 5 === 0 ? "blocked" : "success",
          latencyMs: 100 + i,
          circuitState: "closed",
        }),
      ),
    );

    const result = await pool.query("SELECT * FROM engine_health WHERE engine_key = 'chatgpt' AND bucket_start = $1", [
      new Date(bucketStartMs).toISOString(),
    ]);
    expect(result.rowCount).toBe(1);
    const row = result.rows[0];
    expect(Number(row.attempts)).toBe(50);
    expect(Number(row.blocks)).toBe(10); // i=0,5,10,...,45 → 10 of 50
    expect(Number(row.successes)).toBe(40);
    expect(row.p50_latency_ms).not.toBeNull();
    expect(row.p95_latency_ms).not.toBeNull();
  });

  it("a timestamp exactly on a 5-minute boundary lands in a DIFFERENT row than one 1ms earlier", async () => {
    const boundary = Date.UTC(2026, 0, 1, 11, 0, 0, 0);
    await service.recordAttempt({ engineKey: "claude", atMs: boundary - 1, outcome: "success", circuitState: "closed" });
    await service.recordAttempt({ engineKey: "claude", atMs: boundary, outcome: "success", circuitState: "closed" });

    const result = await pool.query("SELECT bucket_start FROM engine_health WHERE engine_key = 'claude' ORDER BY bucket_start");
    expect(result.rowCount).toBe(2);
    expect(new Date(result.rows[0].bucket_start).getTime()).toBe(boundary - 5 * 60 * 1000);
    expect(new Date(result.rows[1].bucket_start).getTime()).toBe(boundary);
  });

  it("circuit_state mirrors the most recently recorded value", async () => {
    const atMs = Date.UTC(2026, 0, 1, 12, 0, 0, 0);
    await service.recordAttempt({ engineKey: "gemini", atMs, outcome: "blocked", circuitState: "closed" });
    await service.recordAttempt({ engineKey: "gemini", atMs: atMs + 1000, outcome: "blocked", circuitState: "open" });

    const result = await pool.query("SELECT circuit_state FROM engine_health WHERE engine_key = 'gemini' AND bucket_start = $1", [
      new Date(atMs).toISOString(),
    ]);
    expect(result.rows[0].circuit_state).toBe("open");
  });

  it("an event with no latencyMs at all leaves p50/p95 NULL, never 0 — 0ms and absent must stay distinguishable", async () => {
    const atMs = Date.UTC(2026, 0, 1, 13, 0, 0, 0);
    await service.recordAttempt({ engineKey: "perplexity", atMs, outcome: "success", circuitState: "closed" });

    const result = await pool.query("SELECT p50_latency_ms, p95_latency_ms FROM engine_health WHERE engine_key = 'perplexity' AND bucket_start = $1", [
      new Date(atMs).toISOString(),
    ]);
    expect(result.rows[0].p50_latency_ms).toBeNull();
    expect(result.rows[0].p95_latency_ms).toBeNull();
  });
});

// STORY-031 Phase I — D16: "AC10's per-engine status surface ships as a
// service method, not a new HTTP route." perEngineStatus() sums counts over
// a trailing window and reports the latest bucket's latency/circuit_state —
// combining already-computed per-bucket percentiles across buckets would be
// mathematically wrong, so this deliberately reports the LATEST bucket's
// p50/p95 rather than a fabricated cross-bucket aggregate.
describe("STORY-031 · EngineHealthService.perEngineStatus — D16 per-engine status surface, no HTTP route", () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let service: EngineHealthService;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();

    const client = new Client({ connectionString: container.getConnectionUri() });
    await client.connect();
    await migrateUp(client);
    // No `INSERT INTO engines`: migration 0027 seeds the catalog, so the row
    // the `engine_health` FK needs is already there.
    await client.end();

    pool = new Pool({ connectionString: container.getConnectionUri() });
    service = new EngineHealthService(pool);
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  beforeEach(async () => {
    await pool.query("DELETE FROM engine_health");
  });

  it("sums attempts/successes/blocks/timeouts/rateLimited across multiple buckets in the trailing window", async () => {
    const base = Date.UTC(2026, 0, 1, 10, 0, 0, 0);
    await service.recordAttempt({ engineKey: "chatgpt", atMs: base, outcome: "success", circuitState: "closed" });
    await service.recordAttempt({ engineKey: "chatgpt", atMs: base + 5 * 60 * 1000, outcome: "blocked", circuitState: "closed" });
    await service.recordAttempt({ engineKey: "chatgpt", atMs: base + 10 * 60 * 1000, outcome: "timeout", circuitState: "closed" });

    const status = await service.perEngineStatus("chatgpt", base + 11 * 60 * 1000);
    expect(status.attempts).toBe(3);
    expect(status.successes).toBe(1);
    expect(status.blocks).toBe(1);
    expect(status.timeouts).toBe(1);
    expect(status.status).toBe("active");
  });

  it("reports the LATEST bucket's latency and circuit_state, not a cross-bucket fabrication", async () => {
    const base = Date.UTC(2026, 0, 1, 11, 0, 0, 0);
    await service.recordAttempt({ engineKey: "chatgpt", atMs: base, outcome: "success", latencyMs: 100, circuitState: "closed" });
    await service.recordAttempt({
      engineKey: "chatgpt",
      atMs: base + 5 * 60 * 1000,
      outcome: "success",
      latencyMs: 500,
      circuitState: "open",
    });

    const status = await service.perEngineStatus("chatgpt", base + 6 * 60 * 1000);
    expect(status.circuitState).toBe("open");
    expect(status.p50LatencyMs).toBe(500);
  });

  it("an engine with no recorded attempts at all in the window → zero counts, null latency, closed circuit default", async () => {
    const status = await service.perEngineStatus("chatgpt", Date.UTC(2026, 0, 2));
    expect(status.attempts).toBe(0);
    expect(status.successes).toBe(0);
    expect(status.p50LatencyMs).toBeNull();
    expect(status.p95LatencyMs).toBeNull();
    expect(status.circuitState).toBe("closed");
  });

  // qa-reviewer finding — the class-level comment already discloses that
  // p50/p95 are a per-PROCESS reservoir, last-write-wins across replicas
  // (never merged into a true cross-replica percentile), but nothing
  // actually asserted that as the INTENDED behavior. Without a test, a
  // future reader can't tell "known simplification" from "bug nobody
  // noticed." This simulates two replicas (two EngineHealthService
  // instances, each with its own in-process reservoir, sharing one
  // Postgres pool) observing DIFFERENT latencies for the SAME bucket: the
  // stored p50/p95 after both write is provably just whichever wrote
  // LAST, not a merge of both processes' samples — pinning the disclosed
  // limitation rather than leaving it as a comment-only claim.
  it("KNOWN LIMITATION — p50/p95 are per-process, last-write-wins across replicas, never a true cross-replica percentile (see EngineHealthService's `latencies` field doc)", async () => {
    const atMs = Date.UTC(2026, 0, 3, 9, 0, 0, 0);
    const replicaA = new EngineHealthService(pool);
    const replicaB = new EngineHealthService(pool);

    // Replica A observes small latencies only.
    await replicaA.recordAttempt({ engineKey: "chatgpt", atMs, outcome: "success", latencyMs: 10, circuitState: "closed" });
    await replicaA.recordAttempt({ engineKey: "chatgpt", atMs: atMs + 1, outcome: "success", latencyMs: 20, circuitState: "closed" });
    const afterA = await pool.query("SELECT p50_latency_ms FROM engine_health WHERE engine_key = 'chatgpt' AND bucket_start = $1", [
      new Date(atMs).toISOString(),
    ]);
    // Nearest-rank percentile (engine-health.ts) over [10, 20] picks index 0.
    expect(afterA.rows[0].p50_latency_ms).toBe(10);

    // Replica B, a DIFFERENT process with its own empty reservoir, observes
    // large latencies for the SAME bucket. If p50/p95 were a genuine
    // cross-replica percentile, this write would incorporate A's samples
    // too; instead it overwrites the row with ONLY B's own local view.
    await replicaB.recordAttempt({ engineKey: "chatgpt", atMs: atMs + 2, outcome: "success", latencyMs: 9000, circuitState: "closed" });
    const afterB = await pool.query("SELECT p50_latency_ms FROM engine_health WHERE engine_key = 'chatgpt' AND bucket_start = $1", [
      new Date(atMs).toISOString(),
    ]);
    expect(afterB.rows[0].p50_latency_ms).toBe(9000);
    // Proves last-write-wins, not "magically" cross-replica-accurate: B's
    // write is not a merge with A's 10/20ms samples — it is B's own
    // single-sample reservoir, wholly replacing the row A wrote.
    expect(afterB.rows[0].p50_latency_ms).not.toBe(afterA.rows[0].p50_latency_ms);
  });
});

// STORY-031 fix round — EXPLAIN-budget regression gate (testing-strategy.md
// §8/§10: "run when a read path changes"). This story added
// perEngineStatus()'s two engine_health reads (the trailing-window sum and
// the latest-bucket lookup); this proves both are covered by
// engine_health's EXISTING composite PRIMARY KEY (engine_key, bucket_start)
// — engine_key leading — rather than assuming it. `SET enable_seqscan =
// off` mirrors this file's own vector-index EXPLAIN convention
// (test/integration/projects-prompts-captures.spec.ts): it proves the index
// is genuinely USABLE for these WHERE clauses, not merely that the planner
// happens to prefer it over a handful of seed rows.
describe("STORY-031 fix round · EXPLAIN-budget — perEngineStatus() queries use engine_health's existing PK, never a sequential scan", () => {
  let container: StartedPostgreSqlContainer;
  let client: Client;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();

    client = new Client({ connectionString: container.getConnectionUri() });
    await client.connect();
    await migrateUp(client);
    // No `INSERT INTO engines`: migration 0027 seeds the catalog, so the row
    // the `engine_health` FK needs is already there.
    for (let i = 0; i < 20; i++) {
      await client.query("INSERT INTO engine_health (engine_key, bucket_start, attempts) VALUES ('chatgpt', $1, 1)", [
        new Date(Date.UTC(2026, 0, 1, 0, i * 5, 0, 0)).toISOString(),
      ]);
    }
  }, 120_000);

  afterAll(async () => {
    await client.end();
    await container.stop();
  });

  it("the trailing-window sum query (WHERE engine_key = $1 AND bucket_start >= $2) uses engine_health_pkey, not a seq scan", async () => {
    // eslint-disable-next-line nominara/no-session-scoped-config -- test-fixture convenience on a dedicated test connection to force an index scan for verification, not tenant-context traffic; SET LOCAL would silently no-op outside an explicit transaction here.
    await client.query("SET enable_seqscan = off");
    const explain = await client.query(
      "EXPLAIN SELECT COALESCE(SUM(attempts), 0) AS attempts FROM engine_health WHERE engine_key = $1 AND bucket_start >= $2",
      ["chatgpt", new Date(Date.UTC(2026, 0, 1)).toISOString()],
    );
    const plan = explain.rows.map((r) => r["QUERY PLAN"]).join("\n");
    expect(plan).toMatch(/Index.*engine_health_pkey/is);
  });

  it("the latest-bucket query (WHERE engine_key = $1 ORDER BY bucket_start DESC LIMIT 1) uses engine_health_pkey, not a seq scan", async () => {
    // eslint-disable-next-line nominara/no-session-scoped-config -- test-fixture convenience on a dedicated test connection to force an index scan for verification, not tenant-context traffic; SET LOCAL would silently no-op outside an explicit transaction here.
    await client.query("SET enable_seqscan = off");
    const explain = await client.query(
      "EXPLAIN SELECT p50_latency_ms, p95_latency_ms, circuit_state FROM engine_health WHERE engine_key = $1 ORDER BY bucket_start DESC LIMIT 1",
      ["chatgpt"],
    );
    const plan = explain.rows.map((r) => r["QUERY PLAN"]).join("\n");
    expect(plan).toMatch(/Index.*engine_health_pkey/is);
  });

  // readiness()'s engines[] read (HealthService.engineSummaries()) — `key =
  // ANY($1)` against `engines`, a ~10-row reference table. `engines` is
  // small enough that Postgres's cost-based planner will correctly prefer
  // a Seq Scan over the index UNFORCED (a seq scan of 10 rows is cheaper
  // than an index scan there — that is NOT a regression). This proves
  // `engines_pkey` is genuinely usable for this WHERE clause when forced,
  // i.e. no missing/dropped index — the same thing the two tests above
  // prove for engine_health.
  it("readiness's engines[] read (key = ANY($1)) has a usable index on engines(key) — engines_pkey", async () => {
    // eslint-disable-next-line nominara/no-session-scoped-config -- test-fixture convenience on a dedicated test connection to force an index scan for verification, not tenant-context traffic; SET LOCAL would silently no-op outside an explicit transaction here.
    await client.query("SET enable_seqscan = off");
    const explain = await client.query("EXPLAIN SELECT key, status FROM engines WHERE key = ANY($1)", [["chatgpt"]]);
    const plan = explain.rows.map((r) => r["QUERY PLAN"]).join("\n");
    expect(plan).toMatch(/Index.*engines_pkey/is);
  });
});

// STORY-031 Phase J · D19 — "Postgres down → health recording degrades,
// job unaffected." This is a CONFIRMATION test: recordAttempt()'s own
// try/catch (Phase E) already provides this; proven here explicitly rather
// than left implicit.
describe("STORY-031 Phase J · EngineHealthService.recordAttempt — Postgres down never throws, the job is unaffected", () => {
  it("recordAttempt resolves (never rejects) when the pool cannot reach Postgres at all", async () => {
    const brokenPool = new Pool({ connectionString: "postgres://fake:fake@127.0.0.1:1/fake" });
    const service = new EngineHealthService(brokenPool);

    await expect(
      service.recordAttempt({ engineKey: "chatgpt", atMs: Date.now(), outcome: "success", circuitState: "closed" }),
    ).resolves.toBeUndefined();

    await brokenPool.end();
  });
});
