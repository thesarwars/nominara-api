import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { GENESIS_HASH, RECHAINED_MARKER_ACTION, verifyChain } from "../../src/lib/crypto/audit-chain.js";
import { REDACTED } from "../../src/lib/crypto/redact.js";
import { AuditChainService, type AppendAuditRowInput } from "../../src/modules/audit/audit-chain.service.js";
import { readWorkspaceChain } from "../../src/modules/audit/audit-log-reader.js";
import { connectAsRole } from "../isolation/support/runtime-roles.js";

// STORY-020 — dangerous area (audit/tenant boundary), real Postgres
// (testing-strategy.md §1): the hash chain's correctness under concurrency
// cannot be trusted against a mocked pg client.

function input(overrides: Partial<AppendAuditRowInput> = {}): AppendAuditRowInput {
  return {
    workspaceId: overrides.workspaceId ?? "11111111-1111-1111-1111-111111111111",
    actorType: "user",
    actorId: "22222222-2222-2222-2222-222222222222",
    actorIp: "127.0.0.1",
    actorUa: "vitest",
    action: "project.create",
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

const fetchChain = readWorkspaceChain;

describe("STORY-020 · AuditChainService", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let pool: Pool;
  let service: AuditChainService;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await migrateUp(db);
    await db.query(`ALTER ROLE nominara_app PASSWORD ${db.escapeLiteral(resolvePassword("nominara_app", {}))}`);
    pool = new Pool({ connectionString: container.getConnectionUri(), max: 8 });
    service = new AuditChainService();
  }, 120_000);

  afterAll(async () => {
    await db.end();
    await pool.end();
    await container.stop();
  });

  // Mirrors AuditInterceptor's real usage: append() only serializes
  // concurrent writers correctly when it runs inside a transaction that is
  // ALREADY open for the whole request (pg_advisory_xact_lock releases at
  // COMMIT) — a bare autocommit client would release the lock between the
  // SELECT-tail and INSERT statements and defeat the point of taking it.
  async function appendInOwnTransaction(input: AppendAuditRowInput): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await service.append(client, input);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  it("scenario 1 — the first row for a workspace chains onto the genesis hash", async () => {
    const ws = "11111111-1111-1111-1111-111111111111";
    await service.append(db, input({ workspaceId: ws }));
    const [row] = await fetchChain(db, ws);
    expect(row!.prev_hash.equals(GENESIS_HASH)).toBe(true);
  });

  it("chains a second row onto the first row's row_hash, and the chain verifies clean", async () => {
    const ws = "44444444-4444-4444-4444-444444444444";
    await service.append(db, input({ workspaceId: ws, action: "project.create" }));
    await service.append(db, input({ workspaceId: ws, action: "project.update" }));
    const rows = await fetchChain(db, ws);
    expect(rows).toHaveLength(2);
    expect(rows[1]!.prev_hash.equals(rows[0]!.row_hash)).toBe(true);
    expect(verifyChain(rows)).toBeNull();
  });

  it("scenario 7 — redacts a secret-shaped field in after_state before writing", async () => {
    const ws = "55555555-5555-5555-5555-555555555555";
    await service.append(db, input({ workspaceId: ws, afterState: { name: "Acme", apiKey: "hunter2hunter2hunter2" } }));
    const [row] = await fetchChain(db, ws);
    expect((row!.after_state as Record<string, unknown>).apiKey).toBe(REDACTED);
  });

  it("scenario 8 — two tenants' chains are independent; a fresh chain never depends on another workspace's rows", async () => {
    const wsA = "66666666-6666-6666-6666-666666666666";
    const wsB = "77777777-7777-7777-7777-777777777777";
    await service.append(db, input({ workspaceId: wsA, action: "project.create" }));
    await service.append(db, input({ workspaceId: wsA, action: "project.update" }));
    await service.append(db, input({ workspaceId: wsB, action: "project.create" }));

    const rowsA = await fetchChain(db, wsA);
    const rowsB = await fetchChain(db, wsB);
    expect(rowsA).toHaveLength(2);
    expect(rowsB).toHaveLength(1);
    // wsB's first row chains onto genesis, NOT onto wsA's tail — proves the
    // chain key is workspace_id, not a global sequence.
    expect(rowsB[0]!.prev_hash.equals(GENESIS_HASH)).toBe(true);
    expect(verifyChain(rowsA)).toBeNull();
    expect(verifyChain(rowsB)).toBeNull();
  });

  it("concurrent appends to the SAME workspace, each in its own request transaction, never fork the chain", async () => {
    const ws = "88888888-8888-8888-8888-888888888888";
    await Promise.all(
      Array.from({ length: 8 }, (_, i) => appendInOwnTransaction(input({ workspaceId: ws, action: `concurrent.${i}` }))),
    );
    const rows = await fetchChain(db, ws);
    expect(rows).toHaveLength(8);
    expect(verifyChain(rows)).toBeNull();
  });

  it("qa-reviewer blocking #1 — nominara_app (ordinary INSERT grant, no elevated privilege) cannot forge an audit.chain.rechained marker row", async () => {
    const ws = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const appClient = await connectAsRole(
      { host: container.getHost(), port: container.getMappedPort(5432), database: container.getDatabase() },
      "nominara_app",
      resolvePassword("nominara_app", {}),
    );
    const actorId = "22222222-2222-2222-2222-222222222222";
    try {
      await appClient.query("BEGIN");
      await appClient.query("SELECT set_config('app.current_workspace_id', $1, true)", [ws]);
      await appClient.query("SELECT set_config('app.current_actor_id', $1, true)", [actorId]);
      await expect(service.append(appClient, input({ workspaceId: ws, action: RECHAINED_MARKER_ACTION }))).rejects.toThrow(
        /marker rows may only be inserted by a privileged/,
      );
      await appClient.query("ROLLBACK");

      // Confirm the trigger did not silently swallow ordinary appends too —
      // an unrelated action from the SAME role, in a fresh transaction,
      // still succeeds.
      await appClient.query("BEGIN");
      await appClient.query("SELECT set_config('app.current_workspace_id', $1, true)", [ws]);
      await appClient.query("SELECT set_config('app.current_actor_id', $1, true)", [actorId]);
      await service.append(appClient, input({ workspaceId: ws, action: "project.update" }));
      await appClient.query("COMMIT");
      const rows = await fetchChain(db, ws);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.action).toBe("project.update");
    } finally {
      await appClient.end();
    }
  });

  it("support action records the grant reference alongside the support actor type (scenario 11)", async () => {
    const ws = "99999999-9999-9999-9999-999999999999";
    const grantId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    await service.append(
      db,
      input({ workspaceId: ws, actorType: "support", supportGrantId: grantId, action: "project.update" }),
    );
    const [row] = await fetchChain(db, ws);
    expect(row!.actor_type).toBe("support");
    expect(row!.support_grant_id).toBe(grantId);
  });
});
