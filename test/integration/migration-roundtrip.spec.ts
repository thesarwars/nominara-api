import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR } from "../../src/db/migrate-runner.js";
import { checkRoundTrip } from "../../src/db/roundtrip-check.js";

// STORY-006 AC 7 — "Every migration is applied forward and rolled back in CI
// on a shadow database. A rollback that has never executed is not a rollback
// plan." src/db/roundtrip-check.ts is the gate (pnpm db:roundtrip-check,
// wired into .github/workflows/gates.yml); this file proves the gate itself
// is not vacuous: it passes on the real migration set, and it FAILS on each
// way a round trip can be quietly broken.
describe("STORY-006 AC 7 · migration round-trip gate", () => {
  let container: StartedPostgreSqlContainer;
  let client: Client;
  let dir: string;

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
    dir = await mkdtemp(path.join(tmpdir(), "nominara-roundtrip-"));
  });

  afterEach(async () => {
    await client.end();
    await rm(dir, { recursive: true, force: true });
  });

  async function pair(name: string, up: string, down: string | null): Promise<void> {
    await writeFile(path.join(dir, `${name}.up.sql`), up);
    if (down !== null) await writeFile(path.join(dir, `${name}.down.sql`), down);
  }

  it("STORY-006 AC7 · every committed migration applies forward, rolls back to empty and re-applies", async () => {
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".up.sql"));
    const result = await checkRoundTrip(client, MIGRATIONS_DIR);

    expect(result.problems).toEqual([]);
    expect(files.length).toBeGreaterThan(30); // the real set, not a stub directory
    expect(result.migrationCount).toBe(files.length);
  }, 300_000);

  it("STORY-006 AC7 · ZERO migrations found is a failure, never a pass", async () => {
    const result = await checkRoundTrip(client, dir);
    expect(result.migrationCount).toBe(0);
    expect(result.problems.join("\n")).toMatch(/no migrations found/i);
  });

  it("STORY-006 AC7 · a migration with no .down.sql fails, naming it", async () => {
    await pair("0001_widgets", "CREATE TABLE widgets (id int);", null);
    const result = await checkRoundTrip(client, dir);
    expect(result.problems.join("\n")).toMatch(/0001_widgets.*down/i);
  });

  it("STORY-006 AC7 · a down that does not undo its up leaves residue and fails, naming the object", async () => {
    await pair("0001_widgets", "CREATE TABLE widgets (id int);", "SELECT 1;");
    const result = await checkRoundTrip(client, dir);
    expect(result.problems.join("\n")).toMatch(/residue.*widgets/i);
  });

  it("STORY-006 AC7 · a down that throws fails, naming the migration", async () => {
    await pair("0001_widgets", "CREATE TABLE widgets (id int);", "DROP TABLE no_such_table;");
    const result = await checkRoundTrip(client, dir);
    expect(result.problems.join("\n")).toMatch(/0001_widgets/);
    expect(result.problems.join("\n")).toMatch(/no_such_table/);
  });

  it("STORY-006 AC7 · an up that throws fails, naming the migration", async () => {
    await pair("0001_widgets", "CREATE TABLE widgets (id int); SELECT * FROM missing;", "DROP TABLE widgets;");
    const result = await checkRoundTrip(client, dir);
    expect(result.problems.join("\n")).toMatch(/0001_widgets/);
  });

  it("STORY-006 AC7 · a clean pair passes, and the database really is empty afterwards", async () => {
    await pair("0001_widgets", "CREATE TABLE widgets (id int);", "DROP TABLE widgets;");
    await pair("0002_gadgets", "CREATE TABLE gadgets (id int);", "DROP TABLE gadgets;");
    const result = await checkRoundTrip(client, dir);
    expect(result.problems).toEqual([]);
    expect(result.migrationCount).toBe(2);
    const left = await client.query("SELECT 1 FROM pg_tables WHERE schemaname = 'public'");
    expect(left.rowCount).toBe(0);
  });

  it("STORY-006 AC7 · a migration whose rollback cannot be re-applied (down leaves state the up cannot recreate) fails the re-apply leg", async () => {
    // The down removes the table but leaves a type behind; the second apply of the up then collides with it.
    await pair("0001_widgets", "CREATE TYPE widget_kind AS (a int); CREATE TABLE widgets (id int);", "DROP TABLE widgets;");
    const result = await checkRoundTrip(client, dir);
    expect(result.problems.length).toBeGreaterThan(0);
  });
});
