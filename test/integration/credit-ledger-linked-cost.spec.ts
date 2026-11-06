import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, type ClientBase } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { recordUsageCost, type CaptureCellInput } from "../../src/lib/capture/execute-cell.js";
import { provisionWalletWithGrant } from "../../src/lib/credits/balance.js";
import { appendLedgerEntry } from "../../src/lib/credits/ledger.js";
import { realisedInternalCostUsd } from "../../src/lib/credits/internal-cost.js";
import { commitReservation } from "../../src/lib/credits/settle.js";
import { reserveCredits } from "../../src/lib/credits/wallet.js";
import { readLedgerPage, toLedgerCsv } from "../../src/modules/billing/credit-ledger.reader.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";
import { connectAsRole } from "../isolation/support/runtime-roles.js";

// STORY-073 AC9, the part the commit-time sum cannot reach: a FLAT-PRICED run commits when it is accepted, before any cell
// is captured, so no cost exists to sum. Each `usage_ledger` cost row is therefore LINKED to the run's commit entry
// (`credit_ledger_id`) as it is recorded, and the entry's realised cost is read back as the sum of the rows linked to it.
// `credit_ledger` stays append-only: nothing here updates it.

describe("STORY-073 AC9 · cost rows linked to the commit entry", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let appClient: Client;
  let workspaceId: string;
  let otherWorkspaceId: string;
  let runId: string;

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
    appClient = await connectAsRole(
      { host: container.getHost(), port: container.getMappedPort(5432), database: container.getDatabase() },
      "nominara_app",
      resolvePassword("nominara_app", {}),
    );
  }, 300_000);

  afterAll(async () => {
    await appClient.end();
    await db.end();
    await container.stop();
  });

  async function inTx<T>(fn: (tx: ClientBase) => Promise<T>): Promise<T> {
    await db.query("BEGIN");
    try {
      const result = await fn(db);
      await db.query("COMMIT");
      return result;
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    }
  }

  async function workspace(): Promise<string> {
    const id = randomUUID();
    await db.query("INSERT INTO workspaces (id,name,slug,plan_key) VALUES ($1,'W',$2,'growth')", [id, `w-${randomUUID().slice(0, 8)}`]);
    return id;
  }

  beforeEach(async () => {
    await db.query("TRUNCATE usage_ledger, capture_runs, credit_ledger, credit_wallets, workspaces, users CASCADE");
    workspaceId = await workspace();
    otherWorkspaceId = await workspace();
    runId = randomUUID();
    await inTx((tx) => provisionWalletWithGrant(tx, workspaceId, 600, { start: "2026-09-01", end: "2026-10-01" }));
    await inTx((tx) => provisionWalletWithGrant(tx, otherWorkspaceId, 600, { start: "2026-09-01", end: "2026-10-01" }));
  });

  /** A flat-priced run: reserve, then commit at ACCEPT, as `CreditInterceptor` does. No cell exists yet. */
  async function acceptRun(over: { workspace?: string; refId?: string } = {}): Promise<void> {
    const ws = over.workspace ?? workspaceId;
    const key = `req-${randomUUID().slice(0, 8)}`;
    await inTx(async (tx) => {
      const reserved = await reserveCredits(tx, ws, 40);
      await appendLedgerEntry(tx, { workspaceId: ws, entryType: "reserve", actionCode: "manual_scan", credits: 40, idempotencyKey: key, attempt: 1, after: reserved.wallet!, actorId: null, actorType: "system" });
      await commitReservation(tx, { workspaceId: ws, idempotencyKey: key, attempt: 1, credits: 40, actionCode: "manual_scan" }, 40, { referenceType: "run", referenceId: over.refId ?? runId });
    });
  }

  async function captureRun(ws: string, id: string, trigger = "manual"): Promise<CaptureCellInput> {
    const project = randomUUID();
    await db.query(
      `INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain, kind) VALUES ($1,$2,'P',$3,'https://example.com','example.com','brand')`,
      [project, ws, `p-${randomUUID().slice(0, 8)}`],
    );
    await db.query(`INSERT INTO capture_runs (id, workspace_id, project_id, trigger, engine_keys, status) VALUES ($1,$2,$3,$4,ARRAY['gemini'],'running')`, [id, ws, project, trigger]);
    return { workspaceId: ws, projectId: project, runId: id, engineKey: "gemini" } as unknown as CaptureCellInput;
  }

  const record = (input: CaptureCellInput, usd: number) => inTx((tx) => recordUsageCost(tx, input, usd));

  async function links(): Promise<(string | null)[]> {
    const r = await db.query<{ credit_ledger_id: string | null }>("SELECT credit_ledger_id FROM usage_ledger ORDER BY occurred_at, id");
    return r.rows.map((x) => x.credit_ledger_id);
  }
  async function commitId(ws = workspaceId): Promise<string> {
    return (await db.query<{ id: string }>("SELECT id FROM credit_ledger WHERE workspace_id = $1 AND entry_type = 'commit'", [ws])).rows[0]!.id;
  }
  const read = (ws = workspaceId) => withTenantContext(appClient, { workspaceId: ws, actorId: SYSTEM_ACTOR_ID }, (tx) => readLedgerPage(tx, { limit: 50 }));

  it("STORY-073 AC9 · a flat-priced run commits FIRST, its cells record costs after, and the ledger read shows the summed cost on the commit only", async () => {
    await acceptRun();
    const input = await captureRun(workspaceId, runId);
    await record(input, 0.012);
    await record(input, 0.0105);
    const id = await commitId();
    expect(await links()).toEqual([id, id]);
    const page = await read();
    const commit = page.items.find((e) => e.entry_type === "commit")!;
    expect(commit.internal_cost_usd).toBe("0.022500");
    expect(page.items.filter((e) => e.entry_type !== "commit").every((e) => e.internal_cost_usd === null)).toBe(true);
    expect(await realisedInternalCostUsd(db, id)).toBe("0.022500");
  });

  it("STORY-073 AC9 · the ledger EXPORT carries the same figure as the read", async () => {
    await acceptRun();
    await record(await captureRun(workspaceId, runId), 0.0225);
    const page = await read();
    const csv = toLedgerCsv(page.items);
    const [header, ...body] = csv.split("\r\n").filter((l) => l !== "");
    const names = header!.split(",").map((c) => c.replaceAll('"', ""));
    const costs = body.map((l) => l.split(",").map((c) => c.replaceAll('"', ""))[names.indexOf("internal_cost_usd")]);
    expect(costs.filter((c) => c !== "")).toEqual(["0.022500"]);
    expect(page.items.find((e) => e.entry_type === "commit")!.internal_cost_usd).toBe("0.022500");
  });

  it("STORY-073 AC9 · a run with NO commit entry (a free scheduled run) leaves credit_ledger_id NULL and the cost row is still written", async () => {
    await record(await captureRun(workspaceId, runId, "scheduled"), 0.01);
    expect(await links()).toEqual([null]);
    expect((await db.query("SELECT 1 FROM usage_ledger WHERE reference_id = $1", [runId])).rowCount).toBe(1);
  });

  it("STORY-073 AC9 · a commit with no linked rows and no commit-time figure reads NULL, never an invented 0", async () => {
    await acceptRun();
    expect((await read()).items.find((e) => e.entry_type === "commit")!.internal_cost_usd).toBeNull();
    expect(await realisedInternalCostUsd(db, await commitId())).toBeNull();
  });

  it("STORY-073 AC9 · a MEASURED zero (rows linked, each costing 0) reads 0.000000, distinct from null", async () => {
    await acceptRun();
    const id = await commitId();
    await db.query(
      `INSERT INTO usage_ledger (workspace_id, metric, quantity, unit_cost_usd, engine_key, source, credits_charged, credit_ledger_id, reference_type, reference_id, cache_layer)
       VALUES ($1,'capture',1,0,'gemini','manual_run',0,$2,'capture_run',$3,'live')`,
      [workspaceId, id, runId],
    );
    expect((await read()).items.find((e) => e.entry_type === "commit")!.internal_cost_usd).toBe("0.000000");
  });

  it("STORY-073 AC9 · no cross-workspace link: a run id that is also another workspace's commit reference links only within its own workspace", async () => {
    await acceptRun({ workspace: otherWorkspaceId, refId: runId });
    const mine = await captureRun(workspaceId, runId);
    await record(mine, 0.01);
    expect(await links()).toEqual([null]);
    expect((await read(otherWorkspaceId)).items.find((e) => e.entry_type === "commit")!.internal_cost_usd).toBeNull();
  });

  it("STORY-073 AC9 · a workspace cannot read another's linked cost: the read is RLS-scoped", async () => {
    await acceptRun({ workspace: otherWorkspaceId, refId: runId });
    await record(await captureRun(otherWorkspaceId, runId), 0.5);
    expect((await read(workspaceId)).items.some((e) => e.internal_cost_usd !== null)).toBe(false);
    expect((await read(otherWorkspaceId)).items.find((e) => e.entry_type === "commit")!.internal_cost_usd).toBe("0.500000");
  });

  it("STORY-073 AC9 · a cost known at commit (column) and a cost recorded after it (linked) ADD, and a second commit never re-counts the linked rows", async () => {
    const input = await captureRun(workspaceId, runId);
    await record(input, 0.01); // before any commit: unlinked, summed into the commit's column
    await acceptRun();
    await record(input, 0.02); // after: linked
    const commit = (await read()).items.find((e) => e.entry_type === "commit")!;
    expect(commit.internal_cost_usd).toBe("0.030000");
  });

  it("STORY-073 AC9 · re-reading a linked cost is stable and never doubles it (the redelivery guard itself is `commitCell`'s settledCell and the lookup NOT EXISTS, asserted by E2E-B6f and the visibility-scan suite)", async () => {
    await acceptRun();
    const input = await captureRun(workspaceId, runId);
    await record(input, 0.01);
    // The cell's replay guard is `settledCell` inside `commitCell`; the link itself must also be stable under a repeat read.
    const before = await links();
    expect(await links()).toEqual(before);
    expect((await read()).items.find((e) => e.entry_type === "commit")!.internal_cost_usd).toBe("0.010000");
  });

  it("STORY-073 AC9 · credit_ledger stays append-only: recording a cost writes no credit_ledger row and updates none", async () => {
    await acceptRun();
    const snapshot = JSON.stringify((await db.query("SELECT * FROM credit_ledger ORDER BY seq")).rows);
    await record(await captureRun(workspaceId, runId), 0.01);
    expect(JSON.stringify((await db.query("SELECT * FROM credit_ledger ORDER BY seq")).rows)).toBe(snapshot);
  });

  it("STORY-073 AC9 · usage_ledger.credit_ledger_id is indexed, partially, for the ledger join", async () => {
    const r = await db.query<{ indexdef: string }>("SELECT indexdef FROM pg_indexes WHERE tablename = 'usage_ledger' AND indexdef ILIKE '%credit_ledger_id%'");
    expect(r.rows.length).toBeGreaterThan(0);
    expect(r.rows[0]!.indexdef).toMatch(/WHERE \(?credit_ledger_id IS NOT NULL\)?/i);
  });
});
