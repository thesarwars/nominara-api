import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { loadAliasSet, projectAliasFingerprint } from "../../src/lib/capture/l3-short-circuit.js";

// STORY-032 AC8 — does the fingerprint read everything the MATCHER reads?
//
// This is the question the unit tests could not ask. They pass an object
// literal, so they can only check the fields someone remembered to write
// down; nothing mapped database columns onto that literal at all, and two
// omissions had already shipped that way — both root domains, each of them
// changing what entity matching produces while the fingerprint stayed
// identical and a stale parse was copied forward.
//
// Here the question is asked of the database instead: change a column the
// matcher reads, and the fingerprint must move. A column the loader forgets
// fails this by construction, whatever it is called.
describe("STORY-032 · the alias set, read from the database", () => {
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
    await db.query("TRUNCATE competitors, projects, workspaces CASCADE");
    workspaceId = randomUUID();
    projectId = randomUUID();
    await db.query("INSERT INTO workspaces (id, name, slug, plan_key) VALUES ($1, 'W', $2, 'growth')", [
      workspaceId,
      `w-${randomUUID().slice(0, 8)}`,
    ]);
    await db.query(
      `INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain,
                             owned_domains, brand_aliases, negative_aliases)
       VALUES ($1, $2, 'P', $3, 'https://acme.test', 'acme.test',
               ARRAY['shop.acme.test'], ARRAY['Acme','Acme Corp'], ARRAY['Acme Anvils'])`,
      [projectId, workspaceId, `p-${randomUUID().slice(0, 8)}`],
    );
    await db.query(
      `INSERT INTO competitors (workspace_id, project_id, name, aliases, root_domain)
       VALUES ($1, $2, 'Globex', ARRAY['Globex Inc'], 'globex.test')`,
      [workspaceId, projectId],
    );
  });

  it("reads the project's own columns and its competitors", async () => {
    const set = await loadAliasSet(db, projectId);

    expect(set).toEqual({
      rootDomain: "acme.test",
      brandAliases: ["Acme", "Acme Corp"],
      negativeAliases: ["Acme Anvils"],
      ownedDomains: ["shop.acme.test"],
      competitors: [{ name: "Globex", aliases: ["Globex Inc"], rootDomain: "globex.test" }],
    });
  }, 60_000);

  // THE COMPLETENESS CHECK. Each row changes something the Aho-Corasick
  // automaton is built from — §7: "brand_aliases ∪ competitor aliases ∪
  // discovered-candidate labels", plus the domains citation attribution
  // reads. If the loader stops reading any one of them, its row fails.
  it.each([
    ["projects.root_domain", "UPDATE projects SET root_domain = 'acme.example' WHERE id = $1"],
    ["projects.owned_domains", "UPDATE projects SET owned_domains = ARRAY['other.test'] WHERE id = $1"],
    ["projects.brand_aliases", "UPDATE projects SET brand_aliases = ARRAY['Acme','ACME Co'] WHERE id = $1"],
    ["projects.negative_aliases", "UPDATE projects SET negative_aliases = ARRAY['Acme Cartoons'] WHERE id = $1"],
    ["competitors.name", "UPDATE competitors SET name = 'Initech' WHERE project_id = $1"],
    ["competitors.aliases", "UPDATE competitors SET aliases = ARRAY['Globex Ltd'] WHERE project_id = $1"],
    ["competitors.root_domain", "UPDATE competitors SET root_domain = 'globex.example' WHERE project_id = $1"],
  ])("moves when %s changes", async (_column, mutation) => {
    const before = await projectAliasFingerprint(db, projectId);
    await db.query(mutation, [projectId]);
    const after = await projectAliasFingerprint(db, projectId);

    expect(after.equals(before), "a column the fingerprint does not read is a stale parse copied forward").toBe(false);
  }, 60_000);

  it("moves when a competitor is added, and again when one is soft-deleted", async () => {
    const before = await projectAliasFingerprint(db, projectId);

    await db.query(
      `INSERT INTO competitors (workspace_id, project_id, name, aliases, root_domain)
       VALUES ($1, $2, 'Initech', ARRAY[]::text[], NULL)`,
      [workspaceId, projectId],
    );
    const added = await projectAliasFingerprint(db, projectId);
    expect(added.equals(before)).toBe(false);

    // A soft-deleted competitor leaves the automaton, so it must leave the
    // fingerprint — otherwise a short-circuit stays valid against a matcher
    // that no longer contains it.
    await db.query("UPDATE competitors SET deleted_at = now() WHERE project_id = $1 AND name = 'Initech'", [projectId]);
    const removed = await projectAliasFingerprint(db, projectId);
    expect(removed.equals(added), "a removed competitor must invalidate too").toBe(false);
    expect(removed.equals(before), "and removing it returns the set to what it was").toBe(true);
  }, 60_000);

  it("does not depend on the order the database returns competitors in", async () => {
    await db.query(
      `INSERT INTO competitors (workspace_id, project_id, name, aliases, root_domain)
       VALUES ($1, $2, 'Initech', ARRAY['Initech Inc'], 'initech.test')`,
      [workspaceId, projectId],
    );
    const first = await projectAliasFingerprint(db, projectId);
    // Touch the rows so a seq scan would return them in a different order.
    await db.query("UPDATE competitors SET updated_at = now() WHERE project_id = $1 AND name = 'Globex'", [projectId]);

    expect((await projectAliasFingerprint(db, projectId)).equals(first)).toBe(true);
  }, 60_000);

  it("refuses a project it cannot see, rather than fingerprinting an empty set", async () => {
    // An empty alias set hashes to a perfectly stable value, so a missing
    // project would otherwise produce a valid-looking fingerprint that
    // matches no real configuration — and short-circuit against it.
    await expect(projectAliasFingerprint(db, randomUUID())).rejects.toThrow(/does not exist|invisible/u);
  }, 60_000);
});
