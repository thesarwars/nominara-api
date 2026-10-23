import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client, type Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { drizzleOn, withTenantDb } from "../../src/db/drizzle.service.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { createPgPool } from "../../src/db/pg-pool.js";
import { introspectSchema } from "../../src/db/schema/introspect.js";
import * as schema from "../../src/db/schema/index.js";
import { compareSchema, definedTables, isClean } from "../../src/db/schema/schema-check.js";
import { SUBSYSTEM_BY_TABLE } from "../../src/db/schema/subsystems.js";
import { TenantContextMissingError } from "../../src/tenancy/errors.js";

/**
 * Drizzle wraps whatever the driver throws in a DrizzleQueryError and hangs
 * the original off `.cause`. So the guard's refusal DOES reach the caller —
 * loudly, and the ProblemFilter maps it to the same 500 either way, because
 * nothing branches on TenantContextMissingError by type — but `instanceof`
 * at the call site does not see it. Worth knowing before someone writes a
 * catch that expects to.
 */
function guardRefusal(error: unknown): unknown {
  return error instanceof Error && error.cause !== undefined ? error.cause : error;
}

async function refusalFrom(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return null;
  } catch (error) {
    return guardRefusal(error);
  }
}

// STORY-122 — the generated schema against the database it describes, and
// the service seam against the guard it inherits.
//
// As nominara_app throughout, for the reason STORY-120 and STORY-118 both
// paid for: the container superuser bypasses RLS, so a tenant query with no
// context succeeds as the owner and returns zero rows in production. A
// schema layer proven only against the owner would prove the wrong thing.

const EXPECTED_TABLE_COUNT = 83; // 77 + stripe_webhook_events (NEW-D-2, 0048) + scheduled_report_deliveries (NEW-E-1, 0051) + stripe_subscription_syncs (NEW-D-2 checkpoint-1, 0074) + audit_chain_marks (STORY-143, 0123) + credit_hold_carries (STORY-072, 0125) + downgrade_notices (STORY-077, 0134)

describe("STORY-122 · the Drizzle schema layer", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let pool: Pool;
  let seq = 0;

  function runtimeRoleUri(): string {
    const password = encodeURIComponent(resolvePassword("nominara_app", {}));
    return `postgres://nominara_app:${password}@${container.getHost()}:${container.getMappedPort(5432)}/${container.getDatabase()}`;
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();
  }, 180_000);

  afterAll(async () => {
    await container.stop();
  });

  beforeEach(async () => {
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await db.query("DROP SCHEMA IF EXISTS app CASCADE");
    await db.query("DROP SCHEMA IF EXISTS _migrations CASCADE");
    await db.query("DROP SCHEMA public CASCADE");
    await db.query("CREATE SCHEMA public");
    await migrateUp(db);
    await db.query(`ALTER ROLE nominara_app PASSWORD ${db.escapeLiteral(resolvePassword("nominara_app", {}))}`);
    pool = createPgPool(runtimeRoleUri());
  });

  afterEach(async () => {
    await pool.end().catch(() => undefined);
    await db.end();
  });

  async function createWorkspace(): Promise<string> {
    seq += 1;
    const result = await db.query<{ id: string }>(
      "INSERT INTO workspaces (name, slug, plan_key) VALUES ($1, $2, 'free') RETURNING id",
      [`Workspace ${seq}`, `story-122-workspace-${seq}`],
    );
    return result.rows[0]!.id;
  }

  async function createProject(workspaceId: string, name: string): Promise<string> {
    const result = await db.query<{ id: string }>(
      `INSERT INTO projects (workspace_id, name, slug, root_url, root_domain)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [workspaceId, name, `story-122-${(seq += 1)}`, "https://example.com", "example.com"],
    );
    return result.rows[0]!.id;
  }

  // ---- scenario 1 --------------------------------------------------------

  it("scenario 1 — every base table in the migrated database has a definition, and the count is asserted", async () => {
    const tables = await introspectSchema(db);
    // Asserted exactly, the same posture TENANT_TABLES.size takes: a table
    // silently added or dropped should fail HERE and say so, rather than be
    // absorbed by a >= comparison.
    expect(tables.length, "base tables in the migrated database").toBe(EXPECTED_TABLE_COUNT);
    expect(SUBSYSTEM_BY_TABLE.size, "tables assigned to a subsystem").toBe(EXPECTED_TABLE_COUNT);
    expect(definedTables().length, "pgTable definitions exported from src/db/schema").toBe(EXPECTED_TABLE_COUNT);
  });

  it("scenario 1 — and every one of them is described CORRECTLY: types, nullability, primary keys", async () => {
    const result = compareSchema(await introspectSchema(db), definedTables());
    expect(result.undefinedTables).toEqual([]);
    expect(result.orphanedDefinitions).toEqual([]);
    expect(result.columnPresenceMismatches).toEqual([]);
    expect(result.columnMismatches).toEqual([]);
    expect(result.primaryKeyMismatches).toEqual([]);
    expect(isClean(result)).toBe(true);
  });

  // ---- scenario 6 --------------------------------------------------------

  it("scenario 6 — a Drizzle query inside a tenant context returns the tenant's rows, and only the tenant's", async () => {
    const mine = await createWorkspace();
    const theirs = await createWorkspace();
    await createProject(mine, "Mine");
    await createProject(theirs, "Theirs");

    const rows = await withTenantDb(pool, { workspaceId: mine, actorId: crypto.randomUUID() }, async (drizzleDb) =>
      drizzleDb.select({ name: schema.projects.name }).from(schema.projects),
    );

    // RLS is the boundary, and it is still the boundary underneath Drizzle.
    expect(rows.map((row) => row.name)).toEqual(["Mine"]);
  });

  it("scenario 6 — the generated column types round-trip through Drizzle as themselves", async () => {
    const workspaceId = await createWorkspace();
    const projectId = await createProject(workspaceId, "Typed");

    const [row] = await withTenantDb(pool, { workspaceId, actorId: crypto.randomUUID() }, async (drizzleDb) =>
      drizzleDb.select().from(schema.projects).where(eq(schema.projects.id, projectId)),
    );

    expect(row).toBeDefined();
    expect(typeof row!.name).toBe("string");
    expect(Array.isArray(row!.ownedDomains), "text[] arrives as an array, not a brace-string").toBe(true);
    expect(row!.createdAt, "timestamptz arrives as a Date").toBeInstanceOf(Date);
    expect(row!.priorityPromptLimit, "integer arrives as a number").toBeTypeOf("number");
    expect(row!.discovery, "jsonb arrives parsed").toBeTypeOf("object");
  });

  // ---- scenario 7 --------------------------------------------------------

  it("scenario 7 — the same query with the context removed THROWS: STORY-118's guard applies to Drizzle exactly as to raw SQL", async () => {
    const workspaceId = await createWorkspace();
    await createProject(workspaceId, "Unreachable");

    // A checked-out client, but no withTenantContext around it — the shape a
    // future service takes when it forgets. NFR-ARCH-03 names a Drizzle
    // beforeQuery hook as the mechanism; the guard sits beneath the builder
    // on the same pg client, so the property holds with no second hook.
    const client = await pool.connect();
    try {
      const refusal = await refusalFrom(drizzleOn(client).select().from(schema.projects));
      expect(refusal).toBeInstanceOf(TenantContextMissingError);
      expect((refusal as Error).message).toMatch(/projects/);
    } finally {
      client.release();
    }
  });

  it("scenario 7 — and it fails loudly rather than returning the empty list RLS would give it", async () => {
    const workspaceId = await createWorkspace();
    await createProject(workspaceId, "Present");

    const client = await pool.connect();
    try {
      let rows: unknown[] | null = null;
      let error: unknown = null;
      try {
        rows = await drizzleOn(client).select().from(schema.projects);
      } catch (caught) {
        error = caught;
      }
      expect(rows, "an empty array here would be indistinguishable from 'this tenant has no projects'").toBeNull();
      expect(guardRefusal(error)).toBeInstanceOf(TenantContextMissingError);
    } finally {
      client.release();
    }
  });

  // ---- scenario 8 --------------------------------------------------------

  it("scenario 8 — a Drizzle handle built over the POOL cannot query a tenant table", async () => {
    // withTenantDb and drizzleOn take a Pool and a ClientBase respectively,
    // so this is not a shape the exported surface lets you write. It is
    // written here anyway, directly against drizzle(), because the guarantee
    // must not rest on the exports being the only route — a pool-level
    // Drizzle query borrows an implicit connection that can never carry
    // transaction-local context.
    const poolLevel = drizzle(pool as never, { schema });
    const refusal = await refusalFrom(poolLevel.select().from(schema.projects));
    expect(refusal).toBeInstanceOf(TenantContextMissingError);
    expect((refusal as Error).message).toMatch(/on the POOL rather than on a checked-out client/);
  });

  it("scenario 8 — a global table is still reachable that way, because it was never tenant-scoped", async () => {
    const poolLevel = drizzle(pool as never, { schema });
    await expect(poolLevel.select().from(schema.plans)).resolves.toBeInstanceOf(Array);
  });
});
