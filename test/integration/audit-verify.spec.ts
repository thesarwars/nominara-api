import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { AuditChainService, type AppendAuditRowInput } from "../../src/modules/audit/audit-chain.service.js";
import type { ChainMismatchAlert, PagingNotifier } from "../../src/modules/audit/ports/paging-notifier.js";
import { verifyAllChains } from "../../src/workers/rollup/audit-verify.js";

// STORY-020 Test Scenarios 5 & 6 — "Verify a chain -> passes" / "Tamper with
// a row's content in a copy -> the verifier detects it and pages". Real
// Postgres: the tamper case needs a genuine stored, then mutated, row.

class RecordingNotifier implements PagingNotifier {
  readonly alerts: ChainMismatchAlert[] = [];
  async page(alert: ChainMismatchAlert): Promise<void> {
    this.alerts.push(alert);
    await Promise.resolve();
  }
}

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

describe("STORY-020 · audit-verify", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let chain: AuditChainService;

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
  }, 120_000);

  afterAll(async () => {
    await db.end();
    await container.stop();
  });

  it("scenario 5 — a clean chain verifies: no mismatch, notifier never paged", async () => {
    const workspaceId = "aaaaaaaa-0000-0000-0000-000000000010";
    await chain.append(db, input({ workspaceId }));
    await chain.append(db, input({ workspaceId, action: "project.update" }));

    const notifier = new RecordingNotifier();
    const result = await verifyAllChains(db, notifier, [workspaceId]);

    expect(result.mismatch).toBeNull();
    expect(notifier.alerts).toHaveLength(0);
  });

  it("scenario 6 — tampering with a row's stored content is detected and pages exactly once", async () => {
    const workspaceId = "aaaaaaaa-0000-0000-0000-000000000020";
    await chain.append(db, input({ workspaceId }));
    await chain.append(db, input({ workspaceId, action: "project.update" }));

    // Tamper directly — bypassing the append-only trigger the same way the
    // trigger's own reject test proves is normally impossible, to construct
    // the "otherwise-impossible" mismatch scenario 6 requires.
    await db.query("ALTER TABLE audit_log DISABLE TRIGGER reject_update_delete");
    await db.query("UPDATE audit_log SET action = 'project.delete' WHERE workspace_id = $1 AND action = 'project.update'", [
      workspaceId,
    ]);
    await db.query("ALTER TABLE audit_log ENABLE TRIGGER reject_update_delete");

    const notifier = new RecordingNotifier();
    const result = await verifyAllChains(db, notifier, [workspaceId]);

    expect(result.mismatch).not.toBeNull();
    expect(result.mismatch!.workspaceId).toBe(workspaceId);
    expect(result.mismatch!.reason).toBe("hash_mismatch");
    expect(notifier.alerts).toHaveLength(1);
    expect(notifier.alerts[0]!.workspaceId).toBe(workspaceId);
  });

  it("stops at the first mismatch — a clean workspace scanned after a tampered one is never reached", async () => {
    const tamperedWorkspaceId = "aaaaaaaa-0000-0000-0000-000000000030";
    const cleanWorkspaceId = "aaaaaaaa-0000-0000-0000-000000000031";
    await chain.append(db, input({ workspaceId: tamperedWorkspaceId }));
    await chain.append(db, input({ workspaceId: cleanWorkspaceId }));

    await db.query("ALTER TABLE audit_log DISABLE TRIGGER reject_update_delete");
    await db.query("UPDATE audit_log SET action = 'tampered' WHERE workspace_id = $1", [tamperedWorkspaceId]);
    await db.query("ALTER TABLE audit_log ENABLE TRIGGER reject_update_delete");

    const notifier = new RecordingNotifier();
    const result = await verifyAllChains(db, notifier, [tamperedWorkspaceId, cleanWorkspaceId]);

    expect(result.mismatch!.workspaceId).toBe(tamperedWorkspaceId);
    expect(notifier.alerts).toHaveLength(1);
  });
});
