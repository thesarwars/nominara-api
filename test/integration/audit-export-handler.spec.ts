import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { Job } from "bullmq";
import { Client, type Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/config/env.schema.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import type { AuditChainRow } from "../../src/lib/crypto/audit-chain.js";
import { createAuditExportHandler } from "../../src/lib/queue/handlers/audit-export.handler.js";
import { AuditChainService } from "../../src/modules/audit/audit-chain.service.js";
import type { AuditExportIncrement, AuditExportRows, AuditExportSink } from "../../src/modules/audit/ports/export-sink.js";

// batch 18 fix - `audit_log` is FORCE ROW LEVEL SECURITY. The unit spec for this handler injects a fake runExport and
// audit-export.spec.ts drives runAuditExport on the owner client directly, so nothing proved the JOB, with the connection it opens
// itself, sees more than one workspace. This runs the real handler end to end and asserts a non-zero, multi-workspace export through
// the same connection path audit-verify uses (context.env.DATABASE_URL + keepalives, the owner/privileged connection).

const connectedUrls: string[] = [];
vi.mock("../../src/db/client.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/db/client.js")>("../../src/db/client.js");
  return {
    ...actual,
    connect: async (url: string) => {
      connectedUrls.push(url);
      return actual.connect(url);
    },
  };
});

class RecordingSink implements AuditExportSink {
  rows: AuditChainRow[] = [];
  // Follows the port: the handler's export is incremental, so the sink asks before committing and reports what it wrote.
  async export(rows: AuditExportRows, _options: unknown, increment?: AuditExportIncrement): Promise<string | null> {
    for await (const row of rows) this.rows.push(row);
    const written = { dataSha256: "aa".repeat(32), manifestSha256: "bb".repeat(32) };
    if (increment !== undefined && !(await increment.beforeCommit(written))) return null;
    increment?.recordWritten(written);
    return "recorded";
  }
}

describe("batch 18 fix - audit.export handler sees every workspace", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let env: Env;
  const chain = new AuditChainService();
  const tick = (): Job => ({ data: {} }) as unknown as Job;
  const noPool = undefined as unknown as Pool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18").withDatabase("nominara_test").withUsername("nominara").withPassword("nominara").start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await migrateUp(db);
    env = { DATABASE_URL: container.getConnectionUri(), NODE_ENV: "test" } as unknown as Env;
  }, 300_000);

  afterAll(async () => {
    await db.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.query("TRUNCATE audit_log, audit_chain_marks, workspaces CASCADE");
    connectedUrls.length = 0;
  });

  it("exports the rows of several workspaces (non-zero) through the job's own owner connection, with keepalives", async () => {
    const workspaces = ["aaaaaaaa-0000-0000-0000-0000000000a1", "aaaaaaaa-0000-0000-0000-0000000000a2", "aaaaaaaa-0000-0000-0000-0000000000a3"];
    for (const workspaceId of workspaces) {
      for (let i = 0; i < 2; i += 1) {
        await chain.append(db, {
          workspaceId,
          actorType: "user",
          actorId: "22222222-2222-2222-2222-222222222222",
          actorIp: "127.0.0.1",
          actorUa: "vitest",
          action: "project.create",
          resourceType: "project",
          resourceId: "33333333-3333-3333-3333-333333333333",
          beforeState: null,
          afterState: { n: i },
          requestId: "req-1",
          supportGrantId: null,
          severity: "info",
        });
      }
    }
    const sink = new RecordingSink();
    await createAuditExportHandler({ pool: noPool, env } as never, { sinkFor: () => sink })(db, tick());

    expect(sink.rows.length).toBe(6);
    expect(new Set(sink.rows.map((row) => row.workspace_id))).toEqual(new Set(workspaces));
    expect(connectedUrls).toHaveLength(1);
    expect(connectedUrls[0]).toContain("tcp_keepalives_idle%3D60");
    expect(connectedUrls[0]).toContain(new URL(env.DATABASE_URL).host);
  }, 60_000);
});
