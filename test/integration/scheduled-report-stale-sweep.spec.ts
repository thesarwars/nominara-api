import { Logger } from "@nestjs/common";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { uuidV7 } from "../../src/lib/ids/uuidv7.js";
import { STALE_SENDING_REASON, sweepStaleSendingDeliveries } from "../../src/lib/reports/stale-delivery-sweep.js";
import { STALE_SENDING_MS, ScheduledReportsService } from "../../src/modules/reports/scheduled-reports.service.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";

// STORY-183 - the stale `sending` sweep, against real Postgres, writing as nominara_app under FORCE RLS.
describe("STORY-183 · stale `sending` scheduled-report delivery sweep", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let discovery: Client;
  let pool: Pool;
  let metrics: string[];

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18").withDatabase("nominara_test").withUsername("nominara").withPassword("nominara").start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await migrateUp(db);
    await db.query(`ALTER ROLE nominara_app PASSWORD ${db.escapeLiteral(resolvePassword("nominara_app", {}))}`);
    discovery = new Client({ connectionString: container.getConnectionUri() });
    await discovery.connect();
    const appUri = new URL(container.getConnectionUri());
    appUri.username = "nominara_app";
    appUri.password = resolvePassword("nominara_app", {});
    pool = new Pool({ connectionString: appUri.toString(), max: 6 });
  }, 300_000);

  afterAll(async () => {
    await pool.end();
    await discovery.end();
    await db.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.query("TRUNCATE scheduled_report_deliveries, scheduled_reports, workspaces, users CASCADE");
    metrics = [];
    vi.spyOn(Logger.prototype, "log").mockImplementation((message: unknown) => {
      if (typeof message === "object" && message !== null && "metric" in message) metrics.push(JSON.stringify(message));
    });
  });
  afterEach(() => vi.restoreAllMocks());

  const sweep = () => sweepStaleSendingDeliveries({ discovery, work: pool });
  const failedCount = () => metrics.filter((m) => m.includes("nominara_reports_scheduled_deliveries_total") && m.includes('"status":"failed"')).length;

  async function workspace(): Promise<string> {
    const id = uuidV7();
    await db.query(`INSERT INTO workspaces (id, name, slug, org_type, region, timezone, plan_key) VALUES ($1,$2,$3,'in_house','us-east-1','UTC','growth')`, [id, `ws-${id}`, `ws-${id}`]);
    return id;
  }
  async function report(workspaceId: string, lastError: string | null = null): Promise<string> {
    const id = uuidV7();
    await db.query(
      `INSERT INTO scheduled_reports (id, workspace_id, name, project_ids, cadence, recipients, last_error) VALUES ($1,$2,'R',$3,'monthly','{a@example.test}',$4)`,
      [id, workspaceId, [uuidV7()], lastError],
    );
    return id;
  }
  /** A delivery whose attempt began `ageMs` ago on the DATABASE clock. */
  async function delivery(workspaceId: string, reportId: string, status: string, ageMs: number): Promise<string> {
    const id = uuidV7();
    await db.query(
      `INSERT INTO scheduled_report_deliveries (id, workspace_id, scheduled_report_id, status, attempted_at) VALUES ($1,$2,$3,$4, now() - $5 * interval '1 millisecond')`,
      [id, workspaceId, reportId, status, ageMs],
    );
    return id;
  }
  const row = async (id: string) => (await db.query<{ status: string; reason: string | null }>("SELECT status, reason FROM scheduled_report_deliveries WHERE id = $1", [id])).rows[0]!;
  const lastError = async (id: string) => (await db.query<{ last_error: string | null }>("SELECT last_error FROM scheduled_reports WHERE id = $1", [id])).rows[0]!.last_error;
  const STALE = STALE_SENDING_MS + 60_000;
  const FRESH = STALE_SENDING_MS - 60_000;

  /** The service's own finalisation SQL (it uses no instance state), in its own tenant transaction. */
  async function finalise(workspaceId: string, reportId: string, deliveryId: string): Promise<void> {
    const client = await pool.connect();
    try {
      await withTenantContext(client, { workspaceId, actorId: SYSTEM_ACTOR_ID }, (tx) =>
        (ScheduledReportsService.prototype as unknown as { finalize: (...a: unknown[]) => Promise<void> }).finalize.call({}, tx, workspaceId, reportId, deliveryId, "delivered", null, 1),
      );
    } finally {
      client.release();
    }
  }

  it("[STORY-183 AC1] a stale `sending` row becomes `failed` with the fixed reason, the report's last_error is set, and it is counted once as failed", async () => {
    const ws = await workspace();
    const rep = await report(ws);
    const d = await delivery(ws, rep, "sending", STALE);
    const outcome = await sweep();
    expect(outcome).toMatchObject({ swept: 1, failures: [] });
    expect(await row(d)).toEqual({ status: "failed", reason: "delivery did not complete: the sending process did not report back" });
    expect(STALE_SENDING_REASON).toBe("delivery did not complete: the sending process did not report back");
    expect(await lastError(rep)).toBe(STALE_SENDING_REASON);
    expect(failedCount()).toBe(1);
    // Idempotent: a second run finds nothing and counts nothing more.
    expect(await sweep()).toMatchObject({ swept: 0 });
    expect(failedCount()).toBe(1);
  });

  it("[STORY-183 AC5] a fresh `sending` row is left alone, and so are rows in any other state", async () => {
    const ws = await workspace();
    const rep = await report(ws);
    const fresh = await delivery(ws, rep, "sending", FRESH);
    const old = await delivery(ws, rep, "delivered", STALE);
    expect(await sweep()).toMatchObject({ swept: 0 });
    expect(await row(fresh)).toMatchObject({ status: "sending" });
    expect(await row(old)).toMatchObject({ status: "delivered" });
    expect(await lastError(rep)).toBeNull();
    expect(failedCount()).toBe(0);
  });

  it("[STORY-183 AC5] the window boundary: just inside is left alone, just outside is swept (database clock)", async () => {
    const ws = await workspace();
    const rep = await report(ws);
    const inside = await delivery(ws, rep, "sending", STALE_SENDING_MS - 5_000);
    const outside = await delivery(ws, rep, "sending", STALE_SENDING_MS + 5_000);
    await sweep();
    expect((await row(inside)).status).toBe("sending");
    expect((await row(outside)).status).toBe("failed");
  });

  it("[STORY-183 AC3] sweeps every workspace under its own RLS context, each report's last_error set in its own workspace", async () => {
    const [w1, w2] = [await workspace(), await workspace()];
    const [r1, r2] = [await report(w1), await report(w2)];
    const [d1, d2] = [await delivery(w1, r1, "sending", STALE), await delivery(w2, r2, "sending", STALE)];
    expect(await sweep()).toMatchObject({ workspacesChecked: 2, swept: 2 });
    expect([(await row(d1)).status, (await row(d2)).status]).toEqual(["failed", "failed"]);
    expect([await lastError(r1), await lastError(r2)]).toEqual([STALE_SENDING_REASON, STALE_SENDING_REASON]);
  });

  it("[STORY-183 AC2] the sweep racing a finaliser leaves exactly one outcome: the finaliser commits first and stands", async () => {
    const ws = await workspace();
    const rep = await report(ws);
    const d = await delivery(ws, rep, "sending", STALE);
    // The finaliser holds the row (its transaction is open); the sweep waits on that lock, then re-checks `status = 'sending'`.
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT set_config('app.current_workspace_id', $1, true), set_config('app.current_actor_id', $2, true)", [ws, SYSTEM_ACTOR_ID]);
      await (ScheduledReportsService.prototype as unknown as { finalize: (...a: unknown[]) => Promise<void> }).finalize.call({}, holder, ws, rep, d, "delivered", null, 1);
      const sweeping = sweep();
      await new Promise((r) => setTimeout(r, 400));
      await holder.query("COMMIT");
      expect(await sweeping).toMatchObject({ swept: 0 });
    } finally {
      holder.release();
    }
    expect(await row(d)).toEqual({ status: "delivered", reason: null });
    expect(await lastError(rep)).toBeNull();
    expect(failedCount()).toBe(0);
  });

  it("[STORY-183 AC2] the sweep committing first stands, and a late finalisation is then a no-op", async () => {
    const ws = await workspace();
    const rep = await report(ws);
    const d = await delivery(ws, rep, "sending", STALE);
    await sweep();
    await finalise(ws, rep, d);
    expect(await row(d)).toEqual({ status: "failed", reason: STALE_SENDING_REASON });
    expect(await lastError(rep)).toBe(STALE_SENDING_REASON);
    expect((await db.query("SELECT last_sent_at FROM scheduled_reports WHERE id = $1", [rep])).rows[0]!.last_sent_at).toBeNull();
  });

  it("[STORY-183 AC3] two replicas sweeping at once rewrite and count each delivery exactly once", async () => {
    const ws = await workspace();
    const rep = await report(ws);
    await Promise.all(Array.from({ length: 5 }, () => delivery(ws, rep, "sending", STALE)));
    const second = new Client({ connectionString: container.getConnectionUri() });
    await second.connect();
    try {
      await Promise.all([sweep(), sweepStaleSendingDeliveries({ discovery: second, work: pool })]);
    } finally {
      await second.end();
    }
    const stillSending = await db.query("SELECT count(*)::int AS n FROM scheduled_report_deliveries WHERE status = 'sending'");
    expect(stillSending.rows[0]!.n).toBe(0);
    expect(failedCount()).toBe(5);
  });

  it("[STORY-183 AC1] a stale row does not overwrite a NEWER delivery's cleared last_error", async () => {
    const ws = await workspace();
    const rep = await report(ws);
    await delivery(ws, rep, "sending", STALE);
    await delivery(ws, rep, "delivered", 1_000);
    await sweep();
    expect(await lastError(rep)).toBeNull();
  });

  it("[STORY-183 AC3] a report deleted while its delivery was stale takes the delivery with it: nothing to sweep, no error", async () => {
    const ws = await workspace();
    const rep = await report(ws);
    await delivery(ws, rep, "sending", STALE);
    await db.query("DELETE FROM scheduled_reports WHERE id = $1", [rep]);
    expect(await sweep()).toMatchObject({ swept: 0, failures: [] });
  });
});
