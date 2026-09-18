import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, type Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { createMaintenancePartitionHandler } from "../../src/lib/queue/handlers/maintenance-partition.handler.js";
import type { Env } from "../../src/config/env.schema.js";

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

  it("⚠ covers every partitioned fact table, not just the one we looked at", async () => {
    await createMaintenancePartitionHandler({ pool: noPool, env })(db, tick());

    for (const table of ["answer_captures", "mention_facts", "citation_facts"]) {
      const months = await monthsFor(table);
      expect(months.length, table).toBeGreaterThan(2);
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

  it("⚠ reports rows stranded in the DEFAULT partition WITHOUT failing the job", async () => {
    // Retrying cannot move rows, so throwing would put this tick in the
    // dead-letter queue today and again tomorrow while the estate stayed
    // exactly as it was. The run did its work; what is needed is that somebody
    // sees the alert.
    const stranded = new Date(Date.UTC(2030, 0, 15)).toISOString();
    await db.query(
      `INSERT INTO answer_captures
         (workspace_id, project_id, run_id, prompt_id, engine_key, captured_at,
          capture_mode, adapter_version, normalizer_version, content_hash)
       VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'chatgpt', $1,
               'api', 'v1', 'v1', sha256('stranded'::bytea))`,
      [stranded],
    );

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
  }, 60_000);
});
