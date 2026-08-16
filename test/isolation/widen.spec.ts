import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { connectAsRole } from "./support/runtime-roles.js";
import { connectSuperuser } from "./support/assertion-context.js";
import { getAssertionContext, getIsolationProvidedContext } from "./support/context.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import { discoverAllBaseTables } from "./support/discovery.js";
import { uuidV7 } from "../../src/lib/ids/uuidv7.js";

// STORY-012 T26 — the widen pass: edge cases the 16 spec'd assertions don't
// individually name, but that a determined reviewer would ask about.
describe("STORY-012 T26 · widen pass", () => {
  it("empty-string GUC (set_config called with '') behaves identically to an absent GUC — zero rows, not an error", async () => {
    const ctx = getAssertionContext();
    const app = await connectAsRole(ctx.target, "nominara_app");
    try {
      await app.query("BEGIN");
      await app.query("SELECT set_config('app.current_workspace_id', '', true)");
      const result = await app.query<{ count: string }>("SELECT count(*) FROM competitors");
      expect(Number(result.rows[0]!.count)).toBe(0);
      await app.query("COMMIT");
    } finally {
      await app.end();
    }
  });

  it("a malformed-UUID GUC RAISES rather than silently matching zero or every row", async () => {
    const ctx = getAssertionContext();
    const app = await connectAsRole(ctx.target, "nominara_app");
    try {
      await app.query("BEGIN");
      await app.query("SELECT set_config('app.current_workspace_id', 'not-a-uuid', true)");
      await expect(app.query("SELECT count(*) FROM competitors")).rejects.toMatchObject({
        code: expect.stringMatching(/^22/), // invalid_text_representation class
      });
      await app.query("ROLLBACK");
    } finally {
      await app.end();
    }
  });

  it("workspaces (scoped by its own id, not workspace_id) is isolated identically to a workspace_id-scoped table", async () => {
    const ctx = getAssertionContext();
    const { a, b } = ctx.fixture;
    const app = await connectAsRole(ctx.target, "nominara_app");
    try {
      await withTenantContext(app, { workspaceId: a.workspaceId, actorId: SYSTEM_ACTOR_ID }, async (tx) => {
        const rows = await tx.query<{ id: string }>("SELECT id FROM workspaces");
        expect(rows.rows.map((r) => r.id)).toEqual([a.workspaceId]);
        expect(rows.rows.map((r) => r.id)).not.toContain(b.workspaceId);
      });
    } finally {
      await app.end();
    }
  });

  it("a partition child queried BY NAME is isolated identically to its parent", async () => {
    const ctx = getAssertionContext();
    const superuser = await connectSuperuser(ctx);
    let child: string;
    try {
      const result = await superuser.query<{ relname: string }>(
        `SELECT c.relname FROM pg_inherits i
           JOIN pg_class c ON c.oid = i.inhrelid
           JOIN pg_class p ON p.oid = i.inhparent
          WHERE p.relname = 'answer_captures' AND c.relkind = 'r' AND c.relname <> 'answer_captures_default'
          ORDER BY c.relname LIMIT 1`,
      );
      child = result.rows[0]!.relname;
    } finally {
      await superuser.end();
    }

    const app = await connectAsRole(ctx.target, "nominara_app");
    try {
      const result = await app.query<{ count: string }>(`SELECT count(*) FROM ${child}`);
      expect(Number(result.rows[0]!.count)).toBe(0);
    } finally {
      await app.end();
    }
  });

  it("a table with NULL in every row's scope column denies everyone, including its own tenant (fail-closed, not fail-open)", async () => {
    // A disposable database templated off the breaker template, same pattern
    // as every other schema-mutating probe in this suite — never mutate the
    // SHARED seed database every other spec file reads.
    const { host, port, maintenanceDatabase, breakerTemplateDatabase, superuser, fixture } = getIsolationProvidedContext();
    const { a } = fixture;
    // uuidV7, not Date.now() — a millisecond timestamp collides under
    // parallel workers; the UUID is unique per call regardless of timing.
    const dbName = `nominara_iso_widen_null_scope_${uuidV7().replace(/-/g, "")}`;
    const admin = new Client({ host, port, database: maintenanceDatabase, ...superuser });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${dbName} TEMPLATE ${breakerTemplateDatabase}`);
    } finally {
      await admin.end();
    }

    const target = { host, port, database: dbName };
    try {
      const probeSuperuser = new Client({ ...target, ...superuser });
      await probeSuperuser.connect();
      try {
        await probeSuperuser.query("CREATE TABLE widen_null_scope_probe (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid)");
        await probeSuperuser.query("ALTER TABLE widen_null_scope_probe ENABLE ROW LEVEL SECURITY");
        await probeSuperuser.query("ALTER TABLE widen_null_scope_probe FORCE ROW LEVEL SECURITY");
        await probeSuperuser.query(
          "CREATE POLICY ws_isolation_widen_null_scope_probe ON widen_null_scope_probe FOR ALL TO nominara_app USING (workspace_id = app.current_workspace()) WITH CHECK (workspace_id = app.current_workspace())",
        );
        await probeSuperuser.query("GRANT ALL ON widen_null_scope_probe TO nominara_app");
        await probeSuperuser.query("INSERT INTO widen_null_scope_probe (workspace_id) VALUES (NULL)");
      } finally {
        await probeSuperuser.end();
      }

      const app = await connectAsRole(target, "nominara_app");
      try {
        await withTenantContext(app, { workspaceId: a.workspaceId, actorId: SYSTEM_ACTOR_ID }, async (tx) => {
          const rows = await tx.query("SELECT * FROM widen_null_scope_probe");
          expect(rows.rowCount, "NULL workspace_id must never match any real tenant's context").toBe(0);
        });
      } finally {
        await app.end();
      }
    } finally {
      const cleanup = new Client({ host, port, database: maintenanceDatabase, ...superuser });
      await cleanup.connect();
      try {
        await cleanup.query(`DROP DATABASE IF EXISTS ${dbName}`);
      } finally {
        await cleanup.end();
      }
    }
  });

  it("the empty-collection trap: discovery over a schema with zero base tables throws, rather than letting every downstream loop pass vacuously", async () => {
    const { host, port, maintenanceDatabase, superuser } = getIsolationProvidedContext();
    const dbName = `nominara_iso_widen_empty_${Date.now()}`;
    const admin = new Client({ host, port, database: maintenanceDatabase, ...superuser });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${dbName}`);
    } finally {
      await admin.end();
    }

    const empty = new Client({ host, port, database: dbName, ...superuser });
    await empty.connect();
    try {
      await expect(discoverAllBaseTables(empty)).rejects.toThrow(/zero base tables/);
    } finally {
      await empty.end();
      const cleanup = new Client({ host, port, database: maintenanceDatabase, ...superuser });
      await cleanup.connect();
      try {
        await cleanup.query(`DROP DATABASE IF EXISTS ${dbName}`);
      } finally {
        await cleanup.end();
      }
    }
  });

  it("two concurrent contexts on two DIFFERENT clients never authorize each other's queries", async () => {
    const ctx = getAssertionContext();
    const { a, b } = ctx.fixture;
    const clientA = await connectAsRole(ctx.target, "nominara_app");
    const clientB = await connectAsRole(ctx.target, "nominara_app");
    try {
      await Promise.all([
        withTenantContext(clientA, { workspaceId: a.workspaceId, actorId: SYSTEM_ACTOR_ID }, async (tx) => {
          const rows = await tx.query<{ id: string }>("SELECT id FROM projects");
          expect(rows.rows.map((r) => r.id).every((id) => a.projectIds.includes(id))).toBe(true);
        }),
        withTenantContext(clientB, { workspaceId: b.workspaceId, actorId: SYSTEM_ACTOR_ID }, async (tx) => {
          const rows = await tx.query<{ id: string }>("SELECT id FROM projects");
          expect(rows.rows.map((r) => r.id).every((id) => b.projectIds.includes(id))).toBe(true);
        }),
      ]);
    } finally {
      await clientA.end();
      await clientB.end();
    }
  });
});
