import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import type { AuditChainRow } from "../../src/lib/crypto/audit-chain.js";
import { AuditChainService, type AppendAuditRowInput } from "../../src/modules/audit/audit-chain.service.js";
import type { AuditExportOptions, AuditExportRows, AuditExportSink } from "../../src/modules/audit/ports/export-sink.js";
import { AUDIT_EXPORT_RETENTION_DAYS, runAuditExport } from "../../src/workers/rollup/audit-export.js";

// STORY-020 Test Scenario 9 — "Run the export -> Object locked with the
// configured retention". Real Postgres to read genuine chain rows across
// multiple workspaces; a recording fake sink (LocalDirExportSink has its own
// dedicated spec covering the filesystem/locking behavior itself).

class RecordingSink implements AuditExportSink {
  rows: readonly AuditChainRow[] = [];
  options: AuditExportOptions | null = null;
  async export(rows: AuditExportRows, options: AuditExportOptions): Promise<string> {
    const collected: AuditChainRow[] = [];
    for await (const row of rows) collected.push(row);
    this.rows = collected;
    this.options = options;
    return "recorded";
  }
}

function input(overrides: Partial<AppendAuditRowInput> = {}): AppendAuditRowInput {
  return {
    workspaceId: overrides.workspaceId ?? "11111111-1111-1111-1111-111111111111",
    actorType: "user",
    actorId: "22222222-2222-2222-2222-222222222222",
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

describe("STORY-020 · audit-export", () => {
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

  it("scenario 9 — exports every audited workspace's rows with the 7-year retention by default", async () => {
    const wsA = "aaaaaaaa-0000-0000-0000-000000000040";
    const wsB = "aaaaaaaa-0000-0000-0000-000000000041";
    await chain.append(db, input({ workspaceId: wsA }));
    await chain.append(db, input({ workspaceId: wsB, action: "project.update" }));

    const sink = new RecordingSink();
    const location = await runAuditExport(db, sink);

    expect(location).toBe("recorded");
    expect(sink.options).toEqual({ retentionDays: AUDIT_EXPORT_RETENTION_DAYS });
    const exportedWorkspaceIds = new Set(sink.rows.map((row) => row.workspace_id));
    expect(exportedWorkspaceIds.has(wsA)).toBe(true);
    expect(exportedWorkspaceIds.has(wsB)).toBe(true);
  });

  it("honors an explicit retentionDays override", async () => {
    const sink = new RecordingSink();
    await runAuditExport(db, sink, { retentionDays: 30 });
    expect(sink.options).toEqual({ retentionDays: 30 });
  });
});
