import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CONTRACT_PHASE_ANNOTATION } from "../../src/db/additive-guard.js";
import { checkDrift, isClean } from "../../src/db/drift-check.js";
import { MIGRATIONS_DIR, migrateUp, rollbackAll, rollbackLast } from "../../src/db/migrate-runner.js";

// STORY-006 · integration tests run against real Postgres, never a mock, per
// testing-strategy.md §1. All tests share one pgvector/pgvector:pg18
// container (starting a fresh one per test is prohibitively slow) but each
// test gets a hard schema reset in beforeEach, so no test can observe another
// test's migration state.
describe("STORY-006 · extensions, conventions & migration tooling", () => {
  let container: StartedPostgreSqlContainer;
  let client: Client;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();
  }, 120_000);

  afterAll(async () => {
    await container.stop();
  });

  beforeEach(async () => {
    client = new Client({ connectionString: container.getConnectionUri() });
    await client.connect();
    await client.query("DROP SCHEMA IF EXISTS app CASCADE");
    await client.query("DROP SCHEMA IF EXISTS _migrations CASCADE");
    await client.query("DROP SCHEMA public CASCADE");
    await client.query("CREATE SCHEMA public");
  });

  afterEach(async () => {
    await client.end();
  });

  // Scoped to an isolated copy of migration 0001 alone, rather than the real
  // MIGRATIONS_DIR — these tests assert exact migration-name/count results
  // for THIS story's one migration, and must not break every time a later
  // story (0002, 0003, ...) adds another one to the real directory.
  async function isolate0001(): Promise<string> {
    const tempDir = await mkdtemp(path.join(tmpdir(), "nominara-story006-isolated-"));
    for (const ext of ["up", "down"] as const) {
      const content = await readFile(
        path.join(MIGRATIONS_DIR, `0001_extensions_and_conventions.${ext}.sql`),
        "utf8",
      );
      await writeFile(path.join(tempDir, `0001_extensions_and_conventions.${ext}.sql`), content);
    }
    return tempDir;
  }

  it("scenario 1 — applies all migrations from empty, in order", async () => {
    const tempDir = await isolate0001();
    try {
      const applied = await migrateUp(client, tempDir);
      expect(applied).toEqual(["0001_extensions_and_conventions"]);

      const ext = await client.query("SELECT extname FROM pg_extension ORDER BY extname");
      const names = ext.rows.map((r) => r.extname);
      for (const required of ["pgcrypto", "citext", "vector", "pg_trgm", "btree_gin", "pg_stat_statements"]) {
        expect(names).toContain(required);
      }

      const schema = await client.query(
        "SELECT schema_name FROM information_schema.schemata WHERE schema_name = 'app'",
      );
      expect(schema.rowCount).toBe(1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("scenario 2 — rolls back every migration, back to empty", async () => {
    const tempDir = await isolate0001();
    try {
      await migrateUp(client, tempDir);
      const rolledBack = await rollbackAll(client, tempDir);
      expect(rolledBack).toEqual(["0001_extensions_and_conventions"]);

      const schema = await client.query(
        "SELECT schema_name FROM information_schema.schemata WHERE schema_name = 'app'",
      );
      expect(schema.rowCount).toBe(0);

      const applied = await client.query("SELECT name FROM _migrations.applied");
      expect(applied.rowCount).toBe(0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("scenario 3 — a migration that diverges from conventions.ts fails the drift check", async () => {
    // Copy the real migration into an isolated directory, then hand-edit the
    // copy to drop the pg_trgm extension — simulating a migration file that
    // has silently drifted from what conventions.ts declares as required.
    const tempDir = await mkdtemp(path.join(tmpdir(), "nominara-drift-"));
    try {
      const original = await readFile(path.join(MIGRATIONS_DIR, "0001_extensions_and_conventions.up.sql"), "utf8");
      const divergedUp = original.replace("CREATE EXTENSION IF NOT EXISTS pg_trgm;\n", "");
      const originalDown = await readFile(
        path.join(MIGRATIONS_DIR, "0001_extensions_and_conventions.down.sql"),
        "utf8",
      );

      await writeFile(path.join(tempDir, "0001_extensions_and_conventions.up.sql"), divergedUp);
      await writeFile(path.join(tempDir, "0001_extensions_and_conventions.down.sql"), originalDown);

      const result = await checkDrift(client, tempDir);
      expect(isClean(result)).toBe(false);
      expect(result.missingExtensions).toContain("pg_trgm");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("scenario 3b — a migration matching conventions.ts passes the drift check", async () => {
    const result = await checkDrift(client);
    expect(isClean(result)).toBe(true);
  });

  it("scenario 4 — rejects a destructive step on a populated table without the annotation", async () => {
    await migrateUp(client);
    await client.query("CREATE TABLE probe_destructive (id integer PRIMARY KEY, note text)");
    await client.query("INSERT INTO probe_destructive (id, note) VALUES (1, 'seed row')");

    const tempDir = await mkdtemp(path.join(tmpdir(), "nominara-guard-"));
    try {
      await writeFile(
        path.join(tempDir, "0002_drop_note_column.up.sql"),
        "ALTER TABLE probe_destructive DROP COLUMN note;\n",
      );
      await writeFile(path.join(tempDir, "0002_drop_note_column.down.sql"), "-- irreversible in this test\n");

      await expect(migrateUp(client, tempDir)).rejects.toThrow(/populated table/i);

      const stillThere = await client.query(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'probe_destructive' AND column_name = 'note'",
      );
      expect(stillThere.rowCount).toBe(1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("scenario 5 — permits the same destructive step when annotated", async () => {
    await migrateUp(client);
    await client.query("CREATE TABLE probe_destructive (id integer PRIMARY KEY, note text)");
    await client.query("INSERT INTO probe_destructive (id, note) VALUES (1, 'seed row')");

    const tempDir = await mkdtemp(path.join(tmpdir(), "nominara-guard-ok-"));
    try {
      await writeFile(
        path.join(tempDir, "0002_drop_note_column.up.sql"),
        `${CONTRACT_PHASE_ANNOTATION}\nALTER TABLE probe_destructive DROP COLUMN note;\n`,
      );
      await writeFile(path.join(tempDir, "0002_drop_note_column.down.sql"), "-- irreversible in this test\n");

      const applied = await migrateUp(client, tempDir);
      expect(applied).toEqual(["0002_drop_note_column"]);

      const columnGone = await client.query(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'probe_destructive' AND column_name = 'note'",
      );
      expect(columnGone.rowCount).toBe(0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("guard — DROP TABLE on a populated table is rejected without annotation, permitted with it", async () => {
    await migrateUp(client);
    await client.query("CREATE TABLE probe_droppable (id integer PRIMARY KEY)");
    await client.query("INSERT INTO probe_droppable (id) VALUES (1)");

    const rejectDir = await mkdtemp(path.join(tmpdir(), "nominara-guard-droptable-"));
    try {
      await writeFile(path.join(rejectDir, "0002_drop_table.up.sql"), "DROP TABLE probe_droppable;\n");
      await writeFile(path.join(rejectDir, "0002_drop_table.down.sql"), "-- irreversible in this test\n");
      await expect(migrateUp(client, rejectDir)).rejects.toThrow(/populated table/i);

      const stillExists = await client.query(
        "SELECT 1 FROM information_schema.tables WHERE table_name = 'probe_droppable'",
      );
      expect(stillExists.rowCount).toBe(1);
    } finally {
      await rm(rejectDir, { recursive: true, force: true });
    }

    const permitDir = await mkdtemp(path.join(tmpdir(), "nominara-guard-droptable-ok-"));
    try {
      await writeFile(
        path.join(permitDir, "0002_drop_table.up.sql"),
        `${CONTRACT_PHASE_ANNOTATION}\nDROP TABLE probe_droppable;\n`,
      );
      await writeFile(path.join(permitDir, "0002_drop_table.down.sql"), "-- irreversible in this test\n");
      const applied = await migrateUp(client, permitDir);
      expect(applied).toEqual(["0002_drop_table"]);

      const stillExists = await client.query(
        "SELECT 1 FROM information_schema.tables WHERE table_name = 'probe_droppable'",
      );
      expect(stillExists.rowCount).toBe(0);
    } finally {
      await rm(permitDir, { recursive: true, force: true });
    }
  });

  it("guard — TRUNCATE on a populated table is rejected without annotation, permitted with it", async () => {
    await migrateUp(client);
    await client.query("CREATE TABLE probe_truncatable (id integer PRIMARY KEY)");
    await client.query("INSERT INTO probe_truncatable (id) VALUES (1)");

    const rejectDir = await mkdtemp(path.join(tmpdir(), "nominara-guard-truncate-"));
    try {
      await writeFile(path.join(rejectDir, "0002_truncate.up.sql"), "TRUNCATE probe_truncatable;\n");
      await writeFile(path.join(rejectDir, "0002_truncate.down.sql"), "-- irreversible in this test\n");
      await expect(migrateUp(client, rejectDir)).rejects.toThrow(/populated table/i);

      const rowStillThere = await client.query("SELECT 1 FROM probe_truncatable WHERE id = 1");
      expect(rowStillThere.rowCount).toBe(1);
    } finally {
      await rm(rejectDir, { recursive: true, force: true });
    }

    const permitDir = await mkdtemp(path.join(tmpdir(), "nominara-guard-truncate-ok-"));
    try {
      await writeFile(
        path.join(permitDir, "0002_truncate.up.sql"),
        `${CONTRACT_PHASE_ANNOTATION}\nTRUNCATE probe_truncatable;\n`,
      );
      await writeFile(path.join(permitDir, "0002_truncate.down.sql"), "-- irreversible in this test\n");
      const applied = await migrateUp(client, permitDir);
      expect(applied).toEqual(["0002_truncate"]);

      const rowGone = await client.query("SELECT 1 FROM probe_truncatable WHERE id = 1");
      expect(rowGone.rowCount).toBe(0);
    } finally {
      await rm(permitDir, { recursive: true, force: true });
    }
  });

  it("scenario 4c — rejects SET NOT NULL on a populated table without the annotation", async () => {
    await migrateUp(client);
    await client.query("CREATE TABLE probe_set_not_null (id integer PRIMARY KEY, note text)");
    await client.query("INSERT INTO probe_set_not_null (id, note) VALUES (1, 'seed')");

    const tempDir = await mkdtemp(path.join(tmpdir(), "nominara-guard-setnotnull-"));
    try {
      await writeFile(
        path.join(tempDir, "0002_set_note_not_null.up.sql"),
        "ALTER TABLE probe_set_not_null ALTER COLUMN note SET NOT NULL;\n",
      );
      await writeFile(path.join(tempDir, "0002_set_note_not_null.down.sql"), "-- irreversible in this test\n");

      await expect(migrateUp(client, tempDir)).rejects.toThrow(/populated table/i);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("scenario 5c — permits SET NOT NULL on a populated table when annotated", async () => {
    await migrateUp(client);
    await client.query("CREATE TABLE probe_set_not_null (id integer PRIMARY KEY, note text)");
    await client.query("INSERT INTO probe_set_not_null (id, note) VALUES (1, 'seed')");

    const tempDir = await mkdtemp(path.join(tmpdir(), "nominara-guard-setnotnull-ok-"));
    try {
      await writeFile(
        path.join(tempDir, "0002_set_note_not_null.up.sql"),
        `${CONTRACT_PHASE_ANNOTATION}\nALTER TABLE probe_set_not_null ALTER COLUMN note SET NOT NULL;\n`,
      );
      await writeFile(path.join(tempDir, "0002_set_note_not_null.down.sql"), "-- irreversible in this test\n");

      const applied = await migrateUp(client, tempDir);
      expect(applied).toEqual(["0002_set_note_not_null"]);

      const columnIsNotNull = await client.query(
        "SELECT is_nullable FROM information_schema.columns WHERE table_name = 'probe_set_not_null' AND column_name = 'note'",
      );
      expect(columnIsNotNull.rows[0].is_nullable).toBe("NO");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("migrateUp is idempotent — a second call against an already-migrated database applies nothing", async () => {
    const tempDir = await isolate0001();
    try {
      const firstRun = await migrateUp(client, tempDir);
      expect(firstRun).toEqual(["0001_extensions_and_conventions"]);

      const secondRun = await migrateUp(client, tempDir);
      expect(secondRun).toEqual([]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("migrateUp rolls back and does not record a migration that fails mid-transaction", async () => {
    await migrateUp(client);

    const tempDir = await mkdtemp(path.join(tmpdir(), "nominara-atomic-failure-"));
    try {
      // Both statements run in the same transaction; the second violates the
      // primary key, so the whole migration — including the first, otherwise
      // valid, CREATE TABLE — must roll back rather than partially apply.
      await writeFile(
        path.join(tempDir, "0002_atomic_failure.up.sql"),
        "CREATE TABLE probe_atomic (id integer PRIMARY KEY);\n" +
          "INSERT INTO probe_atomic (id) VALUES (1);\n" +
          "INSERT INTO probe_atomic (id) VALUES (1);\n",
      );
      await writeFile(path.join(tempDir, "0002_atomic_failure.down.sql"), "DROP TABLE IF EXISTS probe_atomic;\n");

      await expect(migrateUp(client, tempDir)).rejects.toThrow(/migration 0002_atomic_failure failed/i);

      const tableExists = await client.query(
        "SELECT 1 FROM information_schema.tables WHERE table_name = 'probe_atomic'",
      );
      expect(tableExists.rowCount).toBe(0);

      const recorded = await client.query("SELECT 1 FROM _migrations.applied WHERE name = '0002_atomic_failure'");
      expect(recorded.rowCount).toBe(0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("scenario 7 — the size-guard trigger names table, column, size, and limit on a jsonb column", async () => {
    // data-model.md §1: the guard exists specifically for size-bounded jsonb
    // columns (tool_runs.result_json and similar) — a text column would not
    // have caught the octet_length(jsonb) type mismatch this test guards
    // against, per the code review that found it.
    await migrateUp(client);
    await client.query(`
      CREATE TABLE probe_sized (id integer PRIMARY KEY, payload jsonb);
      CREATE TRIGGER guard_payload_size
        AFTER INSERT OR UPDATE ON probe_sized
        FOR EACH ROW EXECUTE FUNCTION app.assert_jsonb_size('payload', '16');
    `);

    await expect(
      client.query("INSERT INTO probe_sized (id, payload) VALUES (1, $1)", [
        JSON.stringify({ note: "this payload is far too long for the limit" }),
      ]),
    ).rejects.toThrow(/probe_sized\.payload is \d+ bytes, exceeding the 16 byte limit/i);
  });

  it("scenario 7b — the size-guard trigger permits a jsonb value within the limit", async () => {
    await migrateUp(client);
    await client.query(`
      CREATE TABLE probe_sized (id integer PRIMARY KEY, payload jsonb);
      CREATE TRIGGER guard_payload_size
        AFTER INSERT OR UPDATE ON probe_sized
        FOR EACH ROW EXECUTE FUNCTION app.assert_jsonb_size('payload', '64');
    `);

    await expect(
      client.query("INSERT INTO probe_sized (id, payload) VALUES (1, $1)", [JSON.stringify({ ok: true })]),
    ).resolves.toBeDefined();
  });

  it("scenario 4b — rejects a NOT NULL add on a populated table without the annotation", async () => {
    await migrateUp(client);
    await client.query("CREATE TABLE probe_not_null (id integer PRIMARY KEY)");
    await client.query("INSERT INTO probe_not_null (id) VALUES (1)");

    const tempDir = await mkdtemp(path.join(tmpdir(), "nominara-guard-notnull-"));
    try {
      await writeFile(
        path.join(tempDir, "0002_add_required_note.up.sql"),
        "ALTER TABLE probe_not_null ADD COLUMN note text NOT NULL DEFAULT '';\n",
      );
      await writeFile(path.join(tempDir, "0002_add_required_note.down.sql"), "-- irreversible in this test\n");

      await expect(migrateUp(client, tempDir)).rejects.toThrow(/populated table/i);

      const columnExists = await client.query(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'probe_not_null' AND column_name = 'note'",
      );
      expect(columnExists.rowCount).toBe(0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("scenario 5b — permits a NOT NULL add on a populated table when annotated", async () => {
    await migrateUp(client);
    await client.query("CREATE TABLE probe_not_null (id integer PRIMARY KEY)");
    await client.query("INSERT INTO probe_not_null (id) VALUES (1)");

    const tempDir = await mkdtemp(path.join(tmpdir(), "nominara-guard-notnull-ok-"));
    try {
      await writeFile(
        path.join(tempDir, "0002_add_required_note.up.sql"),
        `${CONTRACT_PHASE_ANNOTATION}\nALTER TABLE probe_not_null ADD COLUMN note text NOT NULL DEFAULT '';\n`,
      );
      await writeFile(path.join(tempDir, "0002_add_required_note.down.sql"), "-- irreversible in this test\n");

      const applied = await migrateUp(client, tempDir);
      expect(applied).toEqual(["0002_add_required_note"]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("scenario 8 — updated_at advances on update when the trigger is attached", async () => {
    await migrateUp(client);
    await client.query(`
      CREATE TABLE probe_touched (
        id integer PRIMARY KEY,
        note text,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TRIGGER touch_updated_at
        BEFORE UPDATE ON probe_touched
        FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
    `);
    await client.query("INSERT INTO probe_touched (id, note) VALUES (1, 'first')");
    const before = await client.query("SELECT updated_at FROM probe_touched WHERE id = 1");

    await new Promise((resolve) => setTimeout(resolve, 10));
    await client.query("UPDATE probe_touched SET note = 'second' WHERE id = 1");
    const after = await client.query("SELECT updated_at FROM probe_touched WHERE id = 1");

    expect(new Date(after.rows[0].updated_at).getTime()).toBeGreaterThan(
      new Date(before.rows[0].updated_at).getTime(),
    );
  });

  it("rollbackLast is a no-op returning null against an empty database", async () => {
    const result = await rollbackLast(client);
    expect(result).toBeNull();
  });
});
