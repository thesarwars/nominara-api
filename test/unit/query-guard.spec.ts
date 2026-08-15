import type { ClientBase } from "pg";
import { describe, expect, it } from "vitest";
import { TENANT_TABLES } from "../../src/db/rls/tenant-tables.generated.js";
import { TenantContextMissingError } from "../../src/tenancy/errors.js";
import { assertTenantContext, tenantAware } from "../../src/tenancy/query-guard.js";
import { currentTenantStore, withTenantContext } from "../../src/tenancy/tenant-context.js";

// STORY-011 · src/tenancy/query-guard.ts. The module's own header explains
// this is a heuristic (regex over SQL text), not a real SQL parser, and not
// the actual security boundary — RLS is. These tests exercise exactly that
// heuristic's behavior, not Postgres.
//
// Fix pass item 11 — uses the REAL generated TENANT_TABLES set (59 members)
// instead of a hardcoded 2-table literal, and assertTenantContext now takes
// the CLIENT the query runs on as a required third argument (fix pass item
// 11(c) — see the dedicated describe block below proving the client-identity
// bypass this closes).

function createFakeClient() {
  return {
    query: async (_text: string, _params?: unknown[]) => ({ rows: [] }),
  } as unknown as ClientBase;
}

describe("STORY-011 · fix pass item 11 — TENANT_TABLES is a real, generated 59-member set", () => {
  it("has EXACTLY 59 members and includes representative tables from every migration", () => {
    // Fix pass (second pass) — tightened from toBeGreaterThanOrEqual(59):
    // a table silently added to the set in the future (e.g. a future
    // migration's table misclassified as tenant-scoped, or vice versa)
    // should fail THIS assertion specifically, not rely solely on other,
    // less direct checks elsewhere to catch it.
    expect(TENANT_TABLES.size).toBe(59);
    for (const name of ["workspaces", "projects", "competitors", "answer_captures", "tasks", "share_tokens"]) {
      expect(TENANT_TABLES.has(name), `expected TENANT_TABLES to contain ${name}`).toBe(true);
    }
  });

  it("never contains a GLOBAL_TABLES entry", async () => {
    const { GLOBAL_TABLES } = await import("../../src/db/conventions.js");
    for (const name of GLOBAL_TABLES) {
      expect(TENANT_TABLES.has(name), `TENANT_TABLES unexpectedly contains global table ${name}`).toBe(false);
    }
  });
});

describe("STORY-011 · assertTenantContext — the heuristic table check", () => {
  it("scenario 7 (ISO-prefiguring) — throws for a tenant-table query outside a context-carrying transaction", () => {
    const client = createFakeClient();
    expect(() => assertTenantContext("SELECT * FROM projects", TENANT_TABLES, client)).toThrow(TenantContextMissingError);
  });

  it("does not throw for a tenant-table query while inside withTenantContext on the SAME client", async () => {
    const client = createFakeClient();
    await withTenantContext(client, { workspaceId: "ws", actorId: "actor" }, async () => {
      expect(() => assertTenantContext("SELECT * FROM projects", TENANT_TABLES, client)).not.toThrow();
    });
  });

  it("passes through BEGIN/COMMIT/ROLLBACK/set_config outside any context", () => {
    const client = createFakeClient();
    for (const sql of ["BEGIN", "COMMIT", "ROLLBACK", "SELECT set_config($1, $2, true)"]) {
      expect(() => assertTenantContext(sql, TENANT_TABLES, client)).not.toThrow();
    }
  });

  it("passes through a query touching only a global table, outside any context", () => {
    const client = createFakeClient();
    expect(() => assertTenantContext("SELECT * FROM users WHERE id = $1", TENANT_TABLES, client)).not.toThrow();
  });

  it.each([
    "SELECT * FROM projects WHERE id = $1",
    "SELECT p.* FROM projects p JOIN answer_captures a ON a.project_id = p.id",
    "INSERT INTO projects (id) VALUES ($1)",
    "UPDATE projects SET name = $1 WHERE id = $2",
    "DELETE FROM projects WHERE id = $1",
  ])("throws for %s outside context (covers SELECT/JOIN/INSERT/UPDATE/DELETE)", (sql) => {
    const client = createFakeClient();
    expect(() => assertTenantContext(sql, TENANT_TABLES, client)).toThrow(TenantContextMissingError);
  });

  // ---- boundary cases --------------------------------------------------

  it("boundary — empty SQL never throws", () => {
    const client = createFakeClient();
    expect(() => assertTenantContext("", TENANT_TABLES, client)).not.toThrow();
  });

  it("boundary — comment-only SQL never throws", () => {
    const client = createFakeClient();
    expect(() => assertTenantContext("-- just a comment, no statement here", TENANT_TABLES, client)).not.toThrow();
  });

  it("boundary — a nested withTenantContext call sees ITS OWN store while inside, and the outer store is restored after the inner one exits", async () => {
    const client = createFakeClient();
    const seen: string[] = [];

    await withTenantContext(client, { workspaceId: "outer-ws", actorId: "outer-actor" }, async () => {
      seen.push(currentTenantStore()!.context.workspaceId);
      expect(() => assertTenantContext("SELECT * FROM projects", TENANT_TABLES, client)).not.toThrow();

      await withTenantContext(client, { workspaceId: "inner-ws", actorId: "inner-actor" }, async () => {
        seen.push(currentTenantStore()!.context.workspaceId);
        expect(() => assertTenantContext("SELECT * FROM projects", TENANT_TABLES, client)).not.toThrow();
      });

      seen.push(currentTenantStore()!.context.workspaceId);
      expect(() => assertTenantContext("SELECT * FROM projects", TENANT_TABLES, client)).not.toThrow();
    });

    expect(seen).toEqual(["outer-ws", "inner-ws", "outer-ws"]);
    expect(currentTenantStore()).toBeUndefined();
  });

  it("boundary — a callback that escapes the AsyncLocalStorage scope throws when invoked AFTER withTenantContext has returned", async () => {
    const client = createFakeClient();
    let escaped: (() => void) | undefined;

    await withTenantContext(client, { workspaceId: "ws", actorId: "actor" }, async () => {
      escaped = () => assertTenantContext("SELECT * FROM projects", TENANT_TABLES, client);
      // Still inside the context here — must not throw.
      expect(escaped).not.toThrow();
    });

    // Outside the context now — the exact same call must throw.
    expect(escaped).toThrow(TenantContextMissingError);
  });

  // ---- fix pass item 11(c) — client identity, not just "is ANY store active" ----

  describe("fix pass item 11(c) — the context must be active on THIS client, not just ambiently active on some client", () => {
    it("throws for a tenant-table query on client B while client A has an unrelated context active on the same AsyncLocalStorage chain", async () => {
      const clientA = createFakeClient();
      const clientB = createFakeClient();

      await withTenantContext(clientA, { workspaceId: "ws-a", actorId: "actor-a" }, async () => {
        // Sanity: client A's own query is fine under A's own context.
        expect(() => assertTenantContext("SELECT * FROM projects", TENANT_TABLES, clientA)).not.toThrow();

        // The bug this fix closes: before it, this incorrectly passed,
        // because the ambient-only check only asked "is ANY store active",
        // never "is it active on client B specifically".
        expect(() => assertTenantContext("SELECT * FROM projects", TENANT_TABLES, clientB)).toThrow(
          TenantContextMissingError,
        );
      });
    });

    it("tenantAware wrapping client B rejects a tenant-table query while only client A's context is active", async () => {
      const clientA = createFakeClient();
      const clientB = createFakeClient();
      const guardedB = tenantAware(clientB, TENANT_TABLES);

      await withTenantContext(clientA, { workspaceId: "ws-a", actorId: "actor-a" }, async () => {
        expect(() => guardedB.query("SELECT * FROM projects")).toThrow(TenantContextMissingError);
      });
    });
  });
});

describe("STORY-011 · tenantAware — the Proxy wrapping seam", () => {
  it("intercepts .query() and applies the same check as assertTenantContext — throws synchronously, before any I/O", () => {
    const client = createFakeClient();
    const guarded = tenantAware(client, TENANT_TABLES);
    expect(() => guarded.query("SELECT * FROM projects")).toThrow(TenantContextMissingError);
  });

  it("lets a global-table query through .query() with no active context", async () => {
    const client = createFakeClient();
    const guarded = tenantAware(client, TENANT_TABLES);
    await expect(guarded.query("SELECT * FROM users")).resolves.toEqual({ rows: [] });
  });

  it("lets a tenant-table query through .query() while inside withTenantContext on the SAME underlying client", async () => {
    const client = createFakeClient();
    const guarded = tenantAware(client, TENANT_TABLES);
    await withTenantContext(client, { workspaceId: "ws", actorId: "actor" }, async () => {
      await expect(guarded.query("SELECT * FROM projects")).resolves.toEqual({ rows: [] });
    });
  });
});
