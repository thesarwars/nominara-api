import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { AuditChainService, type AppendAuditRowInput } from "../../src/modules/audit/audit-chain.service.js";
import { AuditQueryService } from "../../src/modules/audit/audit-query.service.js";

// STORY-020 D-3 — AuditQueryService is service-layer only (no HTTP route, no
// role enforcement yet: STORY-020-E-8). Real Postgres because the
// workspace_id defense-in-depth filter and date-range predicates need to be
// proven against actual query semantics, not a mock.

function input(overrides: Partial<AppendAuditRowInput> = {}): AppendAuditRowInput {
  return {
    workspaceId: overrides.workspaceId ?? "11111111-1111-1111-1111-111111111111",
    actorType: "user",
    actorId: overrides.actorId ?? "22222222-2222-2222-2222-222222222222",
    actorIp: "127.0.0.1",
    actorUa: "vitest",
    action: overrides.action ?? "project.create",
    resourceType: "project",
    resourceId: "33333333-3333-3333-3333-333333333333",
    beforeState: null,
    afterState: { name: "Acme" },
    requestId: "req-1",
    supportGrantId: null,
    severity: "info",
    ...overrides,
  };
}

describe("STORY-020 · AuditQueryService", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let chain: AuditChainService;
  let query: AuditQueryService;
  const wsA = "aaaaaaaa-0000-0000-0000-000000000001";
  const wsB = "bbbbbbbb-0000-0000-0000-000000000002";

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await migrateUp(db);
    chain = new AuditChainService();
    query = new AuditQueryService();

    await chain.append(db, input({ workspaceId: wsA, action: "project.create", actorId: "11111111-1111-1111-1111-11111111000a" }));
    await chain.append(db, input({ workspaceId: wsA, action: "project.update", actorId: "22222222-2222-2222-2222-22222222000b" }));
    await chain.append(db, input({ workspaceId: wsA, action: "project.delete", actorId: "11111111-1111-1111-1111-11111111000a" }));
    await chain.append(db, input({ workspaceId: wsB, action: "project.create", actorId: "11111111-1111-1111-1111-11111111000a" }));
  }, 120_000);

  afterAll(async () => {
    await db.end();
    await container.stop();
  });

  it("is queryable by workspace — never returns another workspace's rows", async () => {
    const rows = await query.query(db, { workspaceId: wsA });
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.workspace_id === wsA)).toBe(true);
  });

  it("is queryable by action", async () => {
    const rows = await query.query(db, { workspaceId: wsA, action: "project.update" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe("project.update");
  });

  it("is queryable by actor", async () => {
    const rows = await query.query(db, { workspaceId: wsA, actorId: "22222222-2222-2222-2222-22222222000b" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor_id).toBe("22222222-2222-2222-2222-22222222000b");
  });

  it("is queryable by date range", async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const rows = await query.query(db, { workspaceId: wsA, occurredFrom: future });
    expect(rows).toHaveLength(0);

    const past = new Date(Date.now() - 60_000).toISOString();
    const allRows = await query.query(db, { workspaceId: wsA, occurredFrom: past });
    expect(allRows).toHaveLength(3);
  });

  it("orders most recent first and respects limit", async () => {
    const rows = await query.query(db, { workspaceId: wsA, limit: 1 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe("project.delete");
  });
});
