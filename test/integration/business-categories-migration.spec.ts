import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GLOBAL_TABLES, RUNTIME_ROLES, expectedTablePrivileges } from "../../src/db/conventions.js";
import { MIGRATIONS_DIR, migrateUp } from "../../src/db/migrate-runner.js";

// STORY-189 AC1/AC2 and owner decisions 88 and 91 — migrations 0187 (the taxonomy), 0188 (the curated peers) and 0189 (the constraint).
const CATEGORIES = "business_categories";
const PEERS = "category_peers";
// categories-peer-check.md: the five peer domains that failed the DNS check and are therefore NOT seeded (decision 91).
const FAILED_PEER_DOMAINS = ["goforward.com", "generalmills.com", "amwell.com", "group1auto.com", "flowspace.com"];
// categories-draft.md section 3: the eleven categories whose markets are local, so their peer list is intentionally empty.
const EMPTY_PEER_CATEGORIES = [
  "consumer_law_firms", "business_law_firms", "marketing_agencies", "seo_agencies", "medical_aesthetics", "plumbing_heating_electrical",
  "roofing_contractors", "home_renovation_contractors", "landscaping_services", "house_cleaning_services", "k12_schools",
];

describe("STORY-189 · migrations 0187-0189 — the business category taxonomy", () => {
  let container: StartedPostgreSqlContainer;
  let client: Client;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18").withDatabase("nominara_test").withUsername("nominara").withPassword("nominara").start();
  }, 180_000);
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
    await client.query("GRANT USAGE ON SCHEMA public TO PUBLIC");
  });
  afterEach(async () => {
    await client.end();
  });

  async function insertProject(category: string | null): Promise<string> {
    const workspaceId = randomUUID();
    const projectId = randomUUID();
    await client.query("INSERT INTO workspaces (id, name, slug, plan_key, timezone) VALUES ($1,'W',$2,'growth','UTC')", [workspaceId, `w-${randomUUID().slice(0, 8)}`]);
    await client.query(
      `INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain, category_slug) VALUES ($1,$2,'P',$3,'https://p.example','p.example',$4)`,
      [projectId, workspaceId, `p-${randomUUID().slice(0, 8)}`, category],
    );
    return projectId;
  }

  describe("on a fresh database", () => {
    beforeEach(async () => {
      await migrateUp(client, MIGRATIONS_DIR);
    });

    it("AC1 — seeds exactly 180 categories at taxonomy version 1, each with a stable slug and a display name", async () => {
      const all = await client.query<{ slug: string; name: string; taxonomy_version: number }>(`SELECT slug, name, taxonomy_version FROM ${CATEGORIES} ORDER BY slug`);
      expect(all.rowCount).toBe(180);
      expect(new Set(all.rows.map((r) => r.taxonomy_version))).toEqual(new Set([1]));
      for (const row of all.rows) {
        expect(row.slug, row.slug).toMatch(/^[a-z0-9_]+$/);
        expect(row.name.trim(), row.slug).not.toBe("");
      }
      expect(all.rows.map((r) => r.slug)).toContain("crm");
    });

    it("AC1 — nineteen parent groups, which are parents only (not selectable categories), and one category with no parent", async () => {
      const groups = await client.query<{ parent_slug: string; n: string }>(`SELECT parent_slug, count(*) AS n FROM ${CATEGORIES} WHERE parent_slug IS NOT NULL GROUP BY parent_slug`);
      expect(groups.rowCount).toBe(19);
      expect(Object.fromEntries(groups.rows.map((r) => [r.parent_slug, Number(r.n)])).software_sales_marketing).toBe(11);
      const slugs = new Set((await client.query<{ slug: string }>(`SELECT slug FROM ${CATEGORIES}`)).rows.map((r) => r.slug));
      for (const g of groups.rows) expect(slugs.has(g.parent_slug), `${g.parent_slug} must not be a category`).toBe(false);
      const orphans = await client.query(`SELECT slug FROM ${CATEGORIES} WHERE parent_slug IS NULL`);
      expect(orphans.rows).toEqual([{ slug: "nonprofit_charities" }]);
    });

    it("AC1 — every description is a real sentence to embed, and none uses prohibited vocabulary", async () => {
      const rows = await client.query<{ slug: string; description: string }>(`SELECT slug, description FROM ${CATEGORIES}`);
      for (const r of rows.rows) {
        expect(r.description.length, r.slug).toBeGreaterThan(40);
        expect(r.description, r.slug).not.toMatch(/\b(AVI|ranking|rankings|simulation|fan-out)\b/i);
      }
    });

    it("both tables are GLOBAL: no workspace_id, no row-level security, and conventions.ts declares them", async () => {
      for (const table of [CATEGORIES, PEERS]) {
        const cols = await client.query("SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = 'workspace_id'", [table]);
        expect(cols.rowCount, table).toBe(0);
        const rls = await client.query<{ relrowsecurity: boolean }>("SELECT relrowsecurity FROM pg_class WHERE relname = $1", [table]);
        expect(rls.rows[0]!.relrowsecurity, table).toBe(false);
        expect(GLOBAL_TABLES, table).toContain(table);
      }
    });

    it("decision 91 — read-only to every runtime role: SELECT is granted and nothing else, and a write is refused", async () => {
      for (const table of [CATEGORIES, PEERS]) {
        for (const role of RUNTIME_ROLES) {
          const granted = (
            await client.query<{ privilege_type: string }>("SELECT privilege_type FROM information_schema.role_table_grants WHERE table_name = $1 AND grantee = $2", [table, role])
          ).rows.map((r) => r.privilege_type).sort();
          expect(granted, `${table} ${role}`).toEqual([...expectedTablePrivileges(role, table)].sort());
          expect(granted, `${table} ${role}`).toEqual(["SELECT"]);
        }
      }
      for (const role of ["nominara_app", "nominara_worker"]) {
        await client.query(`SET ROLE ${role}`);
        try {
          await expect(client.query(`UPDATE ${CATEGORIES} SET name = 'x'`)).rejects.toMatchObject({ code: "42501" });
          await expect(client.query(`DELETE FROM ${PEERS}`)).rejects.toMatchObject({ code: "42501" });
          await expect(client.query(`INSERT INTO ${CATEGORIES} (slug, name, description) VALUES ('zz','z','z')`)).rejects.toMatchObject({ code: "42501" });
          expect((await client.query(`SELECT 1 FROM ${CATEGORIES} LIMIT 1`)).rowCount).toBe(1);
        } finally {
          await client.query("RESET ROLE");
        }
      }
    });

    it("decision 91 — seeds the curated peers that passed the DNS check, and not the ones that failed", async () => {
      const total = await client.query<{ n: string }>(`SELECT count(*) AS n FROM ${PEERS}`);
      expect(Number(total.rows[0]!.n)).toBe(834);
      const failed = await client.query(`SELECT root_domain FROM ${PEERS} WHERE root_domain = ANY($1)`, [FAILED_PEER_DOMAINS]);
      expect(failed.rows).toEqual([]);
    });

    it("the eleven local-market categories have no peers; the other 169 each have at least one", async () => {
      const empty = await client.query<{ slug: string }>(
        `SELECT c.slug FROM ${CATEGORIES} c WHERE NOT EXISTS (SELECT 1 FROM ${PEERS} p WHERE p.category_slug = c.slug) ORDER BY c.slug`,
      );
      // The five failed domains each sat in a category with other peers, so the empty set is exactly the draft's eleven.
      expect(empty.rows.map((r) => r.slug)).toEqual([...EMPTY_PEER_CATEGORIES].sort());
    });

    it("a peer carries a name and a lower-case domain, belongs to a real category, and is unique within it", async () => {
      await expect(client.query(`INSERT INTO ${PEERS} (category_slug, root_domain, name) VALUES ('no_such_category','x.com','X')`)).rejects.toMatchObject({ code: "23503" });
      await expect(client.query(`INSERT INTO ${PEERS} (category_slug, root_domain, name) VALUES ('crm','HubSpot.com','H')`)).rejects.toMatchObject({ code: "23514" });
      await expect(client.query(`INSERT INTO ${PEERS} (category_slug, root_domain, name) VALUES ('crm','','H')`)).rejects.toMatchObject({ code: "23514" });
      await client.query(`INSERT INTO ${PEERS} (category_slug, root_domain, name) VALUES ('crm','example-peer.com','Example')`);
      await expect(client.query(`INSERT INTO ${PEERS} (category_slug, root_domain, name) VALUES ('crm','example-peer.com','Again')`)).rejects.toMatchObject({ code: "23505" });
    });

    it("AC2 — projects.category_slug is constrained to the taxonomy: an unknown slug is refused, a known one and null are accepted", async () => {
      await expect(insertProject("not_a_category")).rejects.toMatchObject({ code: "23503" });
      await insertProject("crm");
      await insertProject(null);
    });

    it("AC2 — the constraint also holds on UPDATE", async () => {
      const id = await insertProject("crm");
      await expect(client.query("UPDATE projects SET category_slug = 'not_a_category' WHERE id = $1", [id])).rejects.toMatchObject({ code: "23503" });
      await client.query("UPDATE projects SET category_slug = 'banks' WHERE id = $1", [id]);
    });
  });

  describe("AC2 — on a database that already holds projects", () => {
    it("an existing value outside the taxonomy is REPORTED and kept: the migration neither fails nor drops it", async () => {
      // Apply everything before 0189, put real-looking data in, then apply the rest.
      const staged = await mkdtemp(path.join(tmpdir(), "mig-"));
      try {
        for (const file of await readdir(MIGRATIONS_DIR)) {
          const number = Number.parseInt(file.slice(0, 4), 10);
          if (number < 189) await cp(path.join(MIGRATIONS_DIR, file), path.join(staged, file));
        }
        await migrateUp(client, staged);
        const legacy = await insertProject("saas");
        const known = await insertProject("crm");
        const none = await insertProject(null);

        const notices: string[] = [];
        client.on("notice", (n) => notices.push(n.message ?? ""));
        await migrateUp(client, MIGRATIONS_DIR);

        const rows = await client.query<{ id: string; category_slug: string | null }>("SELECT id, category_slug FROM projects");
        const byId = Object.fromEntries(rows.rows.map((r) => [r.id, r.category_slug]));
        expect(byId[legacy]).toBe("saas");
        expect(byId[known]).toBe("crm");
        expect(byId[none]).toBeNull();
        expect(notices.some((m) => /1 project\(s\).*outside the taxonomy/i.test(m)), JSON.stringify(notices)).toBe(true);

        // The legacy row can still be edited for anything else, but cannot be moved to another unknown value.
        await client.query("UPDATE projects SET name = 'renamed' WHERE id = $1", [legacy]);
        await expect(client.query("UPDATE projects SET category_slug = 'still_unknown' WHERE id = $1", [legacy])).rejects.toMatchObject({ code: "23503" });
        await client.query("UPDATE projects SET category_slug = 'crm' WHERE id = $1", [legacy]);
      } finally {
        await rm(staged, { recursive: true, force: true });
      }
    });
  });
});
