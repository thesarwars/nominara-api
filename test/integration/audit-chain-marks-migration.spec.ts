import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { listMigrationFiles, MIGRATIONS_DIR, migrateUp, rollbackLast } from "../../src/db/migrate-runner.js";
import { RUNTIME_ROLES } from "../../src/db/conventions.js";
import { connectAsRole } from "../isolation/support/runtime-roles.js";

// STORY-143 AC7 — migration 0123_audit_chain_marks: who may touch the marks,
// and whether the down migration really reverses the up.
//
// ⚠ A HIGH-WATER MARK THE APPLICATION CAN REWRITE IS NOT A HIGH-WATER MARK.
// The threat the chain exists for is an actor with write access to audit_log;
// if the same actor can lower or delete the mark, truncation is invisible
// again and the control has moved, not closed. So this connects as each REAL
// runtime role — never as the superuser, which passes every privilege probe
// vacuously — and asserts every verb is refused with 42501.
const MIGRATION_NAME = "0123_audit_chain_marks";

describe("STORY-143 AC7 · audit_chain_marks — owner-only grants and a reversible migration", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await migrateUp(db);
    for (const role of RUNTIME_ROLES) {
      await db.query(`ALTER ROLE ${role} PASSWORD ${db.escapeLiteral(resolvePassword(role, {}))}`);
    }
  }, 300_000);

  afterAll(async () => {
    await db.end();
    await container.stop();
  });

  const target = () => ({ host: container.getHost(), port: container.getMappedPort(5432), database: container.getDatabase() });

  const VERBS: readonly { verb: string; sql: string }[] = [
    { verb: "SELECT", sql: "SELECT * FROM audit_chain_marks" },
    {
      verb: "INSERT",
      sql: "INSERT INTO audit_chain_marks (workspace_id, max_seq, row_hash, reason) VALUES (gen_random_uuid(), 1, decode(repeat('00',32),'hex'), 'verified')",
    },
    { verb: "UPDATE", sql: "UPDATE audit_chain_marks SET max_seq = 0" },
    { verb: "DELETE", sql: "DELETE FROM audit_chain_marks" },
    { verb: "TRUNCATE", sql: "TRUNCATE audit_chain_marks" },
  ];

  for (const role of RUNTIME_ROLES) {
    it(`STORY-143-AC7k · ${role} cannot read, write, update, delete or truncate the marks (42501 on every verb)`, async () => {
      // A real row to aim at, written by the owner connection.
      await db.query(
        "INSERT INTO audit_chain_marks (workspace_id, max_seq, row_hash, reason) VALUES ($1, 7, decode(repeat('01',32),'hex'), 'verified')",
        [randomUUID()],
      );
      const client = await connectAsRole(target(), role, resolvePassword(role, {}));
      try {
        for (const { verb, sql } of VERBS) {
          const code = await client.query(sql).then(
            () => "no error",
            (error: { code?: string }) => error.code ?? "no code",
          );
          expect(code, `${role} ${verb}`).toBe("42501");
        }
      } finally {
        await client.end();
      }
      const survivors = await db.query<{ n: string }>("SELECT count(*) AS n FROM audit_chain_marks WHERE max_seq = 7");
      expect(Number(survivors.rows[0]!.n), "the app role altered a mark").toBeGreaterThanOrEqual(1);
    });
  }

  it("STORY-143-AC7l · even the owner cannot UPDATE or DELETE a mark: the table is append-only", async () => {
    await db.query("INSERT INTO audit_chain_marks (workspace_id, max_seq, row_hash, reason) VALUES ($1, 9, decode(repeat('02',32),'hex'), 'verified')", [
      randomUUID(),
    ]);
    await expect(db.query("UPDATE audit_chain_marks SET max_seq = 0")).rejects.toThrow(/append-only/);
    await expect(db.query("DELETE FROM audit_chain_marks")).rejects.toThrow(/append-only/);
  });

  it("STORY-143-AC7m · the reason and the tombstone shape are constrained", async () => {
    const ws = randomUUID();
    await expect(
      db.query("INSERT INTO audit_chain_marks (workspace_id, max_seq, row_hash, reason) VALUES ($1, 1, decode(repeat('03',32),'hex'), 'made_up')", [ws]),
    ).rejects.toThrow(/ck_audit_chain_marks_reason/);
    await expect(
      db.query("INSERT INTO audit_chain_marks (workspace_id, max_seq, row_hash, reason) VALUES ($1, NULL, NULL, 'verified')", [ws]),
    ).rejects.toThrow(/ck_audit_chain_marks_shape/);
    await expect(
      db.query("INSERT INTO audit_chain_marks (workspace_id, max_seq, row_hash, reason) VALUES ($1, 5, decode(repeat('04',32),'hex'), 'tombstone')", [ws]),
    ).rejects.toThrow(/ck_audit_chain_marks_shape/);
    await db.query("INSERT INTO audit_chain_marks (workspace_id, max_seq, row_hash, reason) VALUES ($1, NULL, NULL, 'tombstone')", [ws]);
  });

  it("STORY-143-AC7n · the marks survive the workspace they describe (no FK that cascades a tombstone away)", async () => {
    const fks = await db.query("SELECT 1 FROM pg_constraint WHERE conrelid = 'audit_chain_marks'::regclass AND contype = 'f'");
    expect(fks.rowCount).toBe(0);
  });

  describe("down migration", () => {
    let dir: string;
    let rt: Client;

    beforeAll(async () => {
      // The chain up to and including this migration, so "last" is this one
      // whatever lands after it.
      dir = await mkdtemp(path.join(tmpdir(), "nominara-s143-"));
      for (const file of await listMigrationFiles(MIGRATIONS_DIR)) {
        if (file.name > MIGRATION_NAME) continue;
        await writeFile(path.join(dir, `${file.name}.up.sql`), await readFile(file.upPath, "utf8"));
        await writeFile(path.join(dir, `${file.name}.down.sql`), await readFile(file.downPath, "utf8"));
      }
      const admin = new Client({ connectionString: container.getConnectionUri().replace(/\/[^/]*$/, "/postgres") });
      await admin.connect();
      await admin.query("DROP DATABASE IF EXISTS s143_roundtrip");
      await admin.query("CREATE DATABASE s143_roundtrip");
      await admin.end();
      rt = new Client({ connectionString: container.getConnectionUri().replace(/\/[^/]*$/, "/s143_roundtrip") });
      await rt.connect();
    }, 120_000);

    afterAll(async () => {
      await rt.end();
      await rm(dir, { recursive: true, force: true });
    });

    /** Everything the up migration could have left behind, as comparable text. */
    async function snapshot(client: Client): Promise<string[]> {
      const parts: string[] = [];
      const push = async (label: string, sql: string) => {
        const result = await client.query<{ line: string }>(sql);
        for (const row of result.rows) parts.push(`${label}: ${row.line}`);
      };
      await push(
        "relation",
        `SELECT c.relname || ' ' || c.relkind::text || ' rls=' || c.relrowsecurity || ' force=' || c.relforcerowsecurity || ' owner=' || pg_get_userbyid(c.relowner) || ' acl=' || coalesce(c.relacl::text, 'NULL') AS line
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname IN ('public','app') ORDER BY 1`,
      );
      await push(
        "column",
        `SELECT attrelid::regclass || '.' || attname || ' ' || format_type(atttypid, atttypmod) || ' notnull=' || attnotnull || ' def=' || coalesce(pg_get_expr(d.adbin, d.adrelid), '') AS line
           FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
          WHERE a.attnum > 0 AND NOT a.attisdropped AND a.attrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'public'::regnamespace) ORDER BY 1`,
      );
      await push("index", "SELECT indexdef AS line FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1");
      await push(
        "constraint",
        "SELECT conrelid::regclass || ' ' || conname || ' ' || pg_get_constraintdef(oid) AS line FROM pg_constraint WHERE connamespace = 'public'::regnamespace ORDER BY 1",
      );
      await push(
        "trigger",
        "SELECT pg_get_triggerdef(oid) AS line FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'public'::regnamespace) ORDER BY 1",
      );
      await push("policy", "SELECT tablename || ' ' || policyname || ' ' || coalesce(qual, '') AS line FROM pg_policies WHERE schemaname = 'public' ORDER BY 1");
      await push(
        "function",
        "SELECT p.oid::regprocedure::text || ' ' || md5(pg_get_functiondef(p.oid)) AS line FROM pg_proc p WHERE prokind IN ('f','p') AND pronamespace IN ('public'::regnamespace, 'app'::regnamespace) ORDER BY 1",
      );
      await push(
        "default-acl",
        "SELECT defaclrole::regrole || ' ' || defaclobjtype::text || ' ' || defaclacl::text AS line FROM pg_default_acl ORDER BY 1",
      );
      await push("comment", "SELECT objoid::regclass || ' ' || description AS line FROM pg_description WHERE classoid = 'pg_class'::regclass AND objoid IN (SELECT oid FROM pg_class WHERE relnamespace = 'public'::regnamespace) ORDER BY 1");
      return parts;
    }

    it("STORY-143-AC7o · up then down leaves the schema, ACLs, triggers and comments exactly as before, and the pair re-applies", async () => {
      const beforeDir = await mkdtemp(path.join(tmpdir(), "nominara-s143-prev-"));
      try {
        for (const file of await listMigrationFiles(dir)) {
          if (file.name === MIGRATION_NAME) continue;
          await writeFile(path.join(beforeDir, `${file.name}.up.sql`), await readFile(file.upPath, "utf8"));
          await writeFile(path.join(beforeDir, `${file.name}.down.sql`), await readFile(file.downPath, "utf8"));
        }
        await migrateUp(rt, beforeDir);
        const before = await snapshot(rt);
        expect(before.some((line) => line.includes("audit_chain_marks"))).toBe(false);

        expect(await migrateUp(rt, dir)).toEqual([MIGRATION_NAME]);
        const during = await snapshot(rt);
        expect(during.some((line) => line.includes("audit_chain_marks")), "the up migration created nothing").toBe(true);

        expect(await rollbackLast(rt, dir)).toBe(MIGRATION_NAME);
        expect(await snapshot(rt)).toEqual(before);

        // And it is repeatable: the second up produces what the first did.
        expect(await migrateUp(rt, dir)).toEqual([MIGRATION_NAME]);
        expect(await snapshot(rt)).toEqual(during);
      } finally {
        await rm(beforeDir, { recursive: true, force: true });
      }
    }, 300_000);
  });
});
