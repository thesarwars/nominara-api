import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { insertPromptStatement, manualPromptRow } from "../../src/lib/promptgen/persist.js";

// *** BOTH OF `insertSuppliedSeeds`'s STATEMENTS HAVE SHIPPED BROKEN. ***
//
// `POST /v1/projects` accepts `competitors[]` and `prompts[]`, and every one
// of those code paths answered 500 from the day it shipped:
//
//   prompts      omitted `text_hash`, `intent_archetype`, `funnel_stage` —
//                three NOT NULL columns with no default. Fixed with
//                STORY-045, covered by promptgen-persist.spec.ts.
//   competitors  named a column that does not exist (`origin`, where the
//                table has `source`) AND a value its CHECK forbids
//                (`'user_authored'` against
//                `CHECK (source IN ('user','auto_detected'))`).
//
// WHY TWO SUITES MISSED BOTH, WHICH IS THE USEFUL PART. The unit test
// asserted `c.sql.includes("user_authored")` against a stubbed client — a
// statement that can never execute satisfies a substring check perfectly, and
// here the substring it checked for was ITSELF the bug. The integration test
// wrote its own correct inserts rather than calling the service.
//
// This file closes that gap the only way it can be closed: by EXECUTING the
// statements against real migrations and asserting on results. Nothing here
// asserts on SQL text.

describe("STORY-043 · supplied competitors and prompts actually insert", () => {
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
    await db.query("TRUNCATE competitors, tracked_prompts, projects, workspaces CASCADE");
    workspaceId = randomUUID();
    projectId = randomUUID();
    await db.query("INSERT INTO workspaces (id, name, slug, plan_key) VALUES ($1, 'W', $2, 'growth')", [
      workspaceId,
      `w-${randomUUID().slice(0, 8)}`,
    ]);
    await db.query(
      `INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain)
       VALUES ($1, $2, 'HubSpot CRM', $3, 'https://hubspot.com', 'hubspot.com')`,
      [projectId, workspaceId, `p-${randomUUID().slice(0, 8)}`],
    );
  });

  /**
   * The competitor insert, verbatim from `ProjectsService.insertSuppliedSeeds`.
   *
   * Copied rather than imported because the method is private and takes the
   * whole request. The unit test asserts the service's bound parameters carry
   * `"user"` and that its SQL names `source` and not `origin`, so the two
   * cannot drift without one of them going red.
   */
  async function insertCompetitor(name: string, rootDomain: string | null = null, aliases: string[] = []): Promise<void> {
    await db.query(
      `INSERT INTO competitors (id, workspace_id, project_id, name, root_domain, aliases, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [randomUUID(), workspaceId, projectId, name, rootDomain, aliases, "user"],
    );
  }

  // ---------------------------------------------------------------------------
  // The regression.
  // ---------------------------------------------------------------------------

  it("a supplied COMPETITOR inserts — the exact statement that answered 500", async () => {
    await insertCompetitor("Salesforce", "salesforce.com", ["SFDC"]);

    const stored = await db.query<{ name: string; source: string; aliases: string[] }>(
      "SELECT name, source, aliases FROM competitors WHERE project_id = $1",
      [projectId],
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]?.source).toBe("user");
    expect(stored.rows[0]?.aliases).toEqual(["SFDC"]);
  });

  it("`user_authored` is REJECTED by the CHECK — the value the shipped code used", async () => {
    // AC5's prose says "user_authored"; the schema says `'user'`. A schema
    // beats prose about a table, and this asserts which one the database
    // actually enforces so the prose cannot quietly win again.
    await expect(
      db.query(
        `INSERT INTO competitors (id, workspace_id, project_id, name, source)
         VALUES ($1,$2,$3,'Salesforce','user_authored')`,
        [randomUUID(), workspaceId, projectId],
      ),
    ).rejects.toThrow(/competitors_source_check|violates check constraint/);
  });

  it("there is no `origin` column — the column the shipped code named", async () => {
    await expect(
      db.query(
        `INSERT INTO competitors (id, workspace_id, project_id, name, origin)
         VALUES ($1,$2,$3,'Salesforce','user')`,
        [randomUUID(), workspaceId, projectId],
      ),
    ).rejects.toThrow(/column "origin" .* does not exist/);
  });

  it("a supplied PROMPT inserts, alongside a competitor", async () => {
    // Both loops in one creation, which is what the onboarding step submits.
    await insertCompetitor("Salesforce");
    const { sql, params } = insertPromptStatement(manualPromptRow({ workspaceId, projectId, text: "best crm" }));
    await db.query(sql, [...params]);

    const competitors = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM competitors WHERE project_id = $1", [projectId]);
    const prompts = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM tracked_prompts WHERE project_id = $1", [projectId]);
    expect(competitors.rows[0]?.n).toBe("1");
    expect(prompts.rows[0]?.n).toBe("1");
  });

  // ---------------------------------------------------------------------------
  // The collision the service now dedupes in memory.
  // ---------------------------------------------------------------------------

  it("two competitors differing only in CASE collide on the unique index", async () => {
    // `ux_competitors_project_name` is unique on `(project_id, lower(name))`.
    // A customer typing "Google" and "google" in the same submission would
    // otherwise fail the whole creation on the second insert — which is why
    // the service dedupes by lowercased name before inserting, the same
    // treatment supplied prompts get for their hash.
    await insertCompetitor("Google");
    await expect(insertCompetitor("google")).rejects.toThrow(/ux_competitors_project_name|duplicate key/);
  });

  it("the same competitor name in ANOTHER project is accepted", async () => {
    // The index is scoped to the project. Two projects both tracking Google
    // is the normal case.
    const otherProject = randomUUID();
    await db.query(
      `INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain)
       VALUES ($1, $2, 'Other', $3, 'https://other.com', 'other.com')`,
      [otherProject, workspaceId, `p-${randomUUID().slice(0, 8)}`],
    );
    await insertCompetitor("Google");
    await expect(
      db.query(
        `INSERT INTO competitors (id, workspace_id, project_id, name, source) VALUES ($1,$2,$3,'Google','user')`,
        [randomUUID(), workspaceId, otherProject],
      ),
    ).resolves.toBeDefined();
  });

  it("defaults `aliases` to an empty array rather than null", async () => {
    // The column is `NOT NULL DEFAULT '{}'`, and the service passes `[]` when
    // the caller supplies none — a null would fail the constraint.
    await insertCompetitor("Pipedrive", null, []);
    const stored = await db.query<{ aliases: string[]; root_domain: string | null }>(
      "SELECT aliases, root_domain FROM competitors WHERE name = 'Pipedrive'",
      [],
    );
    expect(stored.rows[0]?.aliases).toEqual([]);
    expect(stored.rows[0]?.root_domain).toBeNull();
  });
});
