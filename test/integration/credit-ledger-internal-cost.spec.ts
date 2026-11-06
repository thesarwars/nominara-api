import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, type ClientBase } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { provisionWalletWithGrant } from "../../src/lib/credits/balance.js";
import { debitInTransaction } from "../../src/lib/credits/debit.js";
import { appendLedgerEntry } from "../../src/lib/credits/ledger.js";
import { commitReservation } from "../../src/lib/credits/settle.js";
import { reserveCredits } from "../../src/lib/credits/wallet.js";

// STORY-073 AC9 — the internal cost is recorded ON COMMIT, from the usage_ledger rows that name the same run.
//
// ⚠ NULL IS "NOT MEASURED", 0 IS "MEASURED, AND IT COST NOTHING". The two are different statements in an
// append-only financial record, so a commit with no usage rows to sum records NULL and never a zero it did not
// measure; a measured zero records 0.

describe("STORY-073 AC9 · internal cost on commit", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
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
  }, 300_000);

  afterAll(async () => {
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
    await db.query("TRUNCATE usage_ledger, credit_ledger, credit_wallets, workspaces, users CASCADE");
    workspaceId = await workspace();
    otherWorkspaceId = await workspace();
    runId = randomUUID();
    await inTx((tx) => provisionWalletWithGrant(tx, workspaceId, 600, { start: "2026-09-01", end: "2026-10-01" }));
  });

  async function usage(over: { workspace?: string; refType: string; refId: string; usd: string | null; quantity?: number }): Promise<void> {
    await db.query(
      `INSERT INTO usage_ledger (workspace_id, metric, quantity, unit_cost_usd, engine_key, source, credits_charged, reference_type, reference_id, cache_layer)
       VALUES ($1,'capture',$2,$3::numeric,'gemini','manual_run',0,$4,$5,'live')`,
      [over.workspace ?? workspaceId, over.quantity ?? 1, over.usd, over.refType, over.refId],
    );
  }

  /** The guard path: reserve, then settle through `commitReservation` as `CreditInterceptor` does. */
  async function guardedCommit(entry: Parameters<typeof commitReservation>[3]): Promise<void> {
    const key = `req-${randomUUID().slice(0, 8)}`;
    await inTx(async (tx) => {
      const reserved = await reserveCredits(tx, workspaceId, 40);
      await appendLedgerEntry(tx, {
        workspaceId,
        entryType: "reserve",
        actionCode: "manual_scan",
        credits: 40,
        idempotencyKey: key,
        attempt: 1,
        after: reserved.wallet!,
        actorId: null,
        actorType: "system",
      });
      await commitReservation(tx, { workspaceId, idempotencyKey: key, attempt: 1, credits: 40, actionCode: "manual_scan" }, 40, entry);
    });
  }

  async function costs(): Promise<Record<string, string | null>> {
    const rows = await db.query<{ entry_type: string; internal_cost_usd: string | null }>(
      "SELECT entry_type, internal_cost_usd::text FROM credit_ledger WHERE workspace_id = $1 AND entry_type IN ('reserve','commit')",
      [workspaceId],
    );
    return Object.fromEntries(rows.rows.map((r) => [r.entry_type, r.internal_cost_usd]));
  }

  it("STORY-073 AC9 · a settled run's commit carries the SUM of that run's usage_ledger costs, and the reserve carries none", async () => {
    await usage({ refType: "capture_run", refId: runId, usd: "0.012000" });
    await usage({ refType: "capture_run", refId: runId, usd: "0.010500" });
    await guardedCommit({ referenceType: "run", referenceId: runId });
    expect(await costs()).toEqual({ reserve: null, commit: "0.022500" });
  });

  it("STORY-073 AC9 · a quantity above 1 multiplies the unit cost", async () => {
    await usage({ refType: "capture_run", refId: runId, usd: "0.010000", quantity: 3 });
    await guardedCommit({ referenceType: "run", referenceId: runId });
    expect((await costs()).commit).toBe("0.030000");
  });

  it("STORY-073 AC9 · a run whose measured cost is zero records 0, not null", async () => {
    await usage({ refType: "capture_run", refId: runId, usd: "0.000000" });
    await guardedCommit({ referenceType: "run", referenceId: runId });
    expect((await costs()).commit).toBe("0.000000");
  });

  it("STORY-073 AC9 · a run with NOTHING measured records null, never an invented zero", async () => {
    await guardedCommit({ referenceType: "run", referenceId: runId });
    expect((await costs()).commit).toBeNull();
  });

  it("STORY-073 AC9 · a commit that names no reference records null", async () => {
    await usage({ refType: "capture_run", refId: runId, usd: "0.5" });
    await guardedCommit({});
    expect((await costs()).commit).toBeNull();
  });

  it("STORY-073 AC9 · a usage row with an unknown (NULL) unit cost is not a measurement", async () => {
    await usage({ refType: "capture_run", refId: runId, usd: null });
    await guardedCommit({ referenceType: "run", referenceId: runId });
    expect((await costs()).commit).toBeNull();
  });

  it("STORY-073 AC9 · only THIS run's rows count: another run's, another reference type's and another workspace's are excluded", async () => {
    await usage({ refType: "capture_run", refId: runId, usd: "0.010000" });
    await usage({ refType: "capture_run", refId: randomUUID(), usd: "9.000000" });
    await usage({ refType: "tool_run", refId: runId, usd: "9.000000" });
    await usage({ workspace: otherWorkspaceId, refType: "capture_run", refId: runId, usd: "9.000000" });
    await guardedCommit({ referenceType: "run", referenceId: runId });
    expect((await costs()).commit).toBe("0.010000");
  });

  it("STORY-073 AC9 · a value the caller supplied is kept, not overwritten by the sum", async () => {
    await usage({ refType: "capture_run", refId: runId, usd: "0.010000" });
    await guardedCommit({ referenceType: "run", referenceId: runId, internalCostUsd: "1.250000" });
    expect((await costs()).commit).toBe("1.250000");
  });

  it("STORY-073 AC9 · the inline path (tool run, AUX audit) records the sum of the tool run's costs on its commit", async () => {
    await usage({ refType: "tool_run", refId: runId, usd: "0.004000" });
    await usage({ refType: "tool_run", refId: runId, usd: "0.006000" });
    await inTx((tx) =>
      debitInTransaction(tx, {
        workspaceId,
        actorId: null,
        actorType: "system",
        actionCode: "lookup",
        credits: 25,
        idempotencyKey: `tool_run:${runId}`,
        referenceType: "tool_run",
        referenceId: runId,
        includedGrant: 600,
      }),
    );
    expect(await costs()).toEqual({ reserve: null, commit: "0.010000" });
  });

  it("STORY-073 AC9 · the inline path with nothing measured records null", async () => {
    await inTx((tx) =>
      debitInTransaction(tx, {
        workspaceId,
        actorId: null,
        actorType: "system",
        actionCode: "lookup",
        credits: 25,
        idempotencyKey: `tool_run:${runId}`,
        referenceType: "tool_run",
        referenceId: runId,
        includedGrant: 600,
      }),
    );
    expect((await costs()).commit).toBeNull();
  });
});
