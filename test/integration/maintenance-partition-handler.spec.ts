import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, type Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { createMaintenancePartitionHandler } from "../../src/lib/queue/handlers/maintenance-partition.handler.js";
import type { Env } from "../../src/config/env.schema.js";
import { PARTITION_LEAD_MONTHS } from "../../src/db/conventions.js";

// STORY-142 — the tick for `maintenance.partition`.
//
// ⚠ WHAT THESE ARE FOR, because `maintenance.spec.ts` already covers
// `runMonthlyMaintenance` thoroughly and repeating it here would prove
// nothing. What was missing is everything BETWEEN the queue and that
// function: that a handler exists at all, that it opens the OWNER connection
// rather than the pooled one (partitions are DDL and `nominara_app` owns
// none of these tables), that it carries the keepalives that bound its
// blocking advisory lock, and that a default-partition alert is surfaced
// without failing the job.
//
// The estate on 2026-09-18 had partitions through 2026-10 and nothing beyond,
// with no scheduler for this queue — so the first assertion is simply that
// running the tick extends the runway.

const connectedUrls: string[] = [];
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
vi.mock("../../src/db/client.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/db/client.js")>("../../src/db/client.js");
  return {
    ...actual,
    connect: async (url: string) => {
      connectedUrls.push(url);
      return actual.connect(url);
    },
  };
});

describe("STORY-142 · maintenance.partition handler", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let env: Env;

  const tick = (): Job => ({ data: {} }) as unknown as Job;
  /** The handler takes no pool — every statement is DDL on the owner connection. */
  const noPool = undefined as unknown as Pool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await migrateUp(db);
    env = { DATABASE_URL: container.getConnectionUri() } as unknown as Env;
  }, 300_000);

  afterAll(async () => {
    await db.end();
    await container.stop();
  });

  async function monthsFor(table: string): Promise<string[]> {
    const result = await db.query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c
         JOIN pg_inherits i ON c.oid = i.inhrelid
         JOIN pg_class p ON p.oid = i.inhparent
        WHERE p.relname = $1 AND c.relname !~ 'default'
        ORDER BY c.relname`,
      [table],
    );
    return result.rows.map((row) => row.relname);
  }

  it("⚠ extends the partition runway past what the migrations created", async () => {
    // The whole point of the story. Migrations left `answer_captures` covered
    // through 2026-10; from 2026-11 every insert would land in DEFAULT, which
    // does not error and so would not be noticed — and once rows are there,
    // a partition covering their range can no longer simply be attached.
    const before = await monthsFor("answer_captures");

    await createMaintenancePartitionHandler({ pool: noPool, env })(db, tick());

    const after = await monthsFor("answer_captures");
    expect(after.length).toBeGreaterThan(before.length);
    // And the months it added are contiguous with what was already there —
    // a gap would be the same silent DEFAULT problem one month later.
    const suffixes = after.map((name) => name.replace("answer_captures_", ""));
    expect(suffixes).toEqual([...suffixes].sort());
    for (let i = 1; i < suffixes.length; i += 1) {
      const [py, pm] = suffixes[i - 1]!.split("_").map(Number);
      const [cy, cm] = suffixes[i]!.split("_").map(Number);
      const gap = (cy! - py!) * 12 + (cm! - pm!);
      expect(gap, `${suffixes[i - 1]!} -> ${suffixes[i]!}`).toBe(1);
    }
  }, 60_000);

  it("⚠ covers every partitioned fact table, with the FULL lead window on each", async () => {
    // `toBeGreaterThan(2)` was the first version and could not tell a
    // three-month lead from a two-month one, because the migrations already
    // supply two. The months are named instead, derived from
    // PARTITION_LEAD_MONTHS so shortening the lead fails here.
    await createMaintenancePartitionHandler({ pool: noPool, env })(db, tick());

    const now = new Date();
    const expected: string[] = [];
    for (let i = 0; i <= PARTITION_LEAD_MONTHS; i += 1) {
      const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1));
      expected.push(`${String(month.getUTCFullYear())}_${String(month.getUTCMonth() + 1).padStart(2, "0")}`);
    }

    for (const table of ["answer_captures", "mention_facts", "citation_facts"]) {
      const suffixes = (await monthsFor(table)).map((name) => name.replace(`${table}_`, ""));
      expect(suffixes, table).toEqual(expect.arrayContaining(expected));
    }
  }, 60_000);

  it("⚠ HOLDS the maintenance advisory lock while it runs", async () => {
    // The premise for `withKeepalives`, and nothing asserted it: a review
    // replaced the whole body with partition-creation-only — no lock at all —
    // and every test in this file still passed. The lock is what makes the
    // keepalives meaningful, and what stops two replicas issuing the same DDL.
    const blocker = new Client({ connectionString: container.getConnectionUri() });
    await blocker.connect();
    try {
      const taken = await blocker.query<{ got: boolean }>(
        "SELECT pg_try_advisory_lock(hashtext($1)::bigint) AS got",
        ["maintenance.partition"],
      );
      expect(taken.rows[0]!.got).toBe(true);

      // The handler's own lock is the BLOCKING kind, so with the key held it
      // must not finish. If it completes, it never asked for the lock.
      const running = createMaintenancePartitionHandler({ pool: noPool, env })(db, tick());
      const raced = await Promise.race([
        running.then(() => "finished" as const),
        new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 1_500)),
      ]);
      expect(raced).toBe("blocked");

      await blocker.query("SELECT pg_advisory_unlock(hashtext($1)::bigint)", ["maintenance.partition"]);
      await running;
    } finally {
      await blocker.end();
    }
  }, 60_000);

  it("is idempotent — a second tick creates nothing and does not throw", async () => {
    // It runs daily, so all but roughly one run a month does nothing. If that
    // were not free, the cadence would be wrong.
    await createMaintenancePartitionHandler({ pool: noPool, env })(db, tick());
    const after = await monthsFor("answer_captures");

    await expect(createMaintenancePartitionHandler({ pool: noPool, env })(db, tick())).resolves.toBeUndefined();

    expect(await monthsFor("answer_captures")).toEqual(after);
  }, 60_000);

  it("⚠ opens the OWNER connection, carrying the keepalives that bound its lock", async () => {
    // Two claims in one, both wiring rather than logic. `runMonthlyMaintenance`
    // issues CREATE/ATTACH/DETACH/DROP, which the pooled `nominara_app` role
    // cannot do — and it holds a BLOCKING session advisory lock for the whole
    // run, so a partitioned replica would leave the next tick waiting on a
    // privileged connection for the OS keepalive default of two hours.
    connectedUrls.length = 0;

    await createMaintenancePartitionHandler({ pool: noPool, env })(db, tick());

    expect(connectedUrls).toHaveLength(1);
    expect(connectedUrls[0]).toContain("tcp_keepalives_idle%3D60");
    // The owner url, not a pooled one — asserted as identity with what it was
    // handed, so swapping in DATABASE_URL_POOLED could not pass.
    expect(connectedUrls[0]).toContain(new URL(env.DATABASE_URL).host);
  }, 60_000);

  it("⚠ a row stranded INSIDE the lead window does not stop the rest of the estate", async () => {
    // ⚠ THE FAILURE THIS STORY NEARLY CAUSED ITSELF. A single row in a DEFAULT
    // partition whose month falls inside the lead window makes that month's
    // CREATE...ATTACH fail — "updated partition constraint for default
    // partition would be violated by some row". The first cut propagated it,
    // so NOTHING was created: not that month, not later months, and not the
    // other two tables, which were never reached. Reproduced against a real
    // database: the job that guards the runway refusing to run, every day,
    // while the runway expired.
    //
    // The earlier version of this test used a 2030 date, which is harmless
    // only because 2030 is outside the lead window — it passed precisely
    // because it chose a date the hazard cannot reach. This one is two months
    // out, which is inside it.
    const inWindow = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 2, 15));
    // Earlier tests in this file have already extended the runway, so the
    // month has to be taken away again for the row to reach DEFAULT at all —
    // which is exactly the state a fresh deployment is in.
    const suffix = `${String(inWindow.getUTCFullYear())}_${String(inWindow.getUTCMonth() + 1).padStart(2, "0")}`;
    await db.query(`DROP TABLE IF EXISTS answer_captures_${suffix}`);
    await insertCapture(inWindow.toISOString());
    expect((await monthsFor("answer_captures")).some((n) => n.endsWith(suffix))).toBe(false);

    const warnings: string[] = [];
    const errors: string[] = [];
    const { Logger } = await import("@nestjs/common");
    const warnSpy = vi.spyOn(Logger.prototype, "warn").mockImplementation((m: unknown) => void warnings.push(String(m)));
    const errSpy = vi.spyOn(Logger.prototype, "error").mockImplementation((m: unknown) => void errors.push(String(m)));

    try {
      await expect(createMaintenancePartitionHandler({ pool: noPool, env })(db, tick())).resolves.toBeUndefined();
    } finally {
      warnSpy.mockRestore();
      errSpy.mockRestore();
    }

    // The blocked month is reported rather than swallowed...
    expect(errors.some((line) => line.includes("could not create"))).toBe(true);
    expect(counters.some((c) => c.name === "partition_create_failed")).toBe(true);
    // ...the alert still fired, because detection now runs BEFORE creation...
    expect(warnings.some((line) => line.includes("DEFAULT partition"))).toBe(true);
    // ...and the other two tables got their partitions anyway.
    for (const table of ["mention_facts", "citation_facts"]) {
      expect((await monthsFor(table)).length, table).toBeGreaterThan(2);
    }
  }, 60_000);

  it("⚠ reports rows stranded in the DEFAULT partition WITHOUT failing the job", async () => {
    // Retrying cannot move rows, so throwing would put this tick in the
    // dead-letter queue today and again tomorrow while the estate stayed
    // exactly as it was. The run did its work; what is needed is that somebody
    // sees the alert.
    await insertCapture(new Date(Date.UTC(2030, 0, 15)).toISOString());
    counters.length = 0;

    const warnings: string[] = [];
    const warnSpy = vi
      .spyOn((await import("@nestjs/common")).Logger.prototype, "warn")
      .mockImplementation((message: unknown) => void warnings.push(String(message)));

    try {
      await expect(createMaintenancePartitionHandler({ pool: noPool, env })(db, tick())).resolves.toBeUndefined();
    } finally {
      warnSpy.mockRestore();
    }

    expect(warnings.some((line) => line.includes("DEFAULT partition"))).toBe(true);
    // ⚠ AND THE COUNTER, which the handler's own comment calls the substitute
    // for the ops script's non-zero exit — i.e. the alerting mechanism. It was
    // untested: deleting it and keeping the log passed every test here.
    const alerted = counters.filter((c) => c.name === "partition_default_rows_detected");
    expect(alerted).toHaveLength(1);
    expect(alerted[0]!.labels.table).toBe("answer_captures");
  }, 60_000);

  async function insertCapture(capturedAt: string): Promise<void> {
    await db.query(
      `INSERT INTO answer_captures
         (workspace_id, project_id, run_id, prompt_id, engine_key, captured_at,
          capture_mode, adapter_version, normalizer_version, content_hash)
       VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'chatgpt', $1,
               'api', 'v1', 'v1', sha256($2::bytea))`,
      [capturedAt, capturedAt],
    );
  }
});
