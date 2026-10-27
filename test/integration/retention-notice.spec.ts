import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { Logger } from "@nestjs/common";
import { trace } from "@opentelemetry/api";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { RETENTION_FIRST_PURGE_DAYS, recordRetentionShortening } from "../../src/lib/billing/retention-shortening.js";
import { rawRetentionCutoff } from "../../src/modules/tracking/raw-retention.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";
import { resolveWorkspaceRetention, runNightlySweep } from "../../src/workers/rollup/retention.js";

// STORY-077 slice B · EC-41 · data-model.md §7. A plan change that SHORTENS retention is announced (a recorded email naming
// exactly what will be purged and when), the first purge is deferred to day 15, and the nightly sweep honours the deferral
// without widening what it deletes.
//
// Runs the lib as `nominara_app` (FORCE RLS in force) inside the tenant context a plan writer opens; the sweep runs on the
// owner connection, as it does in production (cross-tenant discovery).
const DAY = 86_400_000;

describe("STORY-077 slice B · retention-shortening notice and deferred first purge", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let pool: Pool;
  let seq = 0;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18").withDatabase("nominara_test").withUsername("nominara").withPassword("nominara").start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await migrateUp(db);
    await db.query(`ALTER ROLE nominara_app PASSWORD ${db.escapeLiteral(resolvePassword("nominara_app", {}))}`);
    const appUri = new URL(container.getConnectionUri());
    appUri.username = "nominara_app";
    appUri.password = resolvePassword("nominara_app", {});
    pool = new Pool({ connectionString: appUri.toString(), max: 4 });
  }, 180_000);

  afterAll(async () => {
    await db.end();
    await pool.end();
    await container.stop();
  });

  async function workspace(planKey: string, billingEmail: string | null = "billing@example.com"): Promise<string> {
    seq += 1;
    const r = await db.query<{ id: string }>("INSERT INTO workspaces (name, slug, plan_key, billing_email) VALUES ($1, $2, $3, $4) RETURNING id", [
      `WS ${String(seq)}`,
      `ws-${String(seq)}-${Math.random().toString(36).slice(2)}`,
      planKey,
      billingEmail,
    ]);
    return r.rows[0]!.id;
  }

  async function project(workspaceId: string, name: string): Promise<string> {
    seq += 1;
    const r = await db.query<{ id: string }>(
      "INSERT INTO projects (workspace_id, name, slug, root_url, root_domain) VALUES ($1, $2, $3, 'https://example.com', 'example.com') RETURNING id",
      [workspaceId, name, `p-${String(seq)}-${Math.random().toString(36).slice(2)}`],
    );
    return r.rows[0]!.id;
  }

  async function capture(workspaceId: string, projectId: string, capturedAt: Date): Promise<string> {
    seq += 1;
    const r = await db.query<{ id: string }>(
      `INSERT INTO answer_captures (workspace_id, project_id, run_id, prompt_id, engine_key, captured_at, capture_mode, adapter_version, normalizer_version, content_hash, raw_object_key, response_excerpt)
       VALUES ($1, $2, gen_random_uuid(), gen_random_uuid(), 'chatgpt', $3, 'api', 'v1', 'v1', decode('00','hex'), $4, 'excerpt') RETURNING id`,
      [workspaceId, projectId, capturedAt.toISOString(), `raw/${String(seq)}.json`],
    );
    return r.rows[0]!.id;
  }

  async function metric(workspaceId: string, projectId: string, date: string): Promise<void> {
    await db.query(
      "INSERT INTO metric_daily (workspace_id, project_id, engine_key, entity_type, entity_id, metric_date) VALUES ($1, $2, 'chatgpt', 'brand', gen_random_uuid(), $3)",
      [workspaceId, projectId, date],
    );
  }

  async function record(workspaceId: string, fromPlanKey: string, toPlanKey: string, requestId: string, now: Date) {
    const client = await pool.connect();
    try {
      return await withTenantContext(client, { workspaceId, actorId: SYSTEM_ACTOR_ID }, (tx) => recordRetentionShortening(tx, workspaceId, { fromPlanKey, toPlanKey, requestId, now }));
    } finally {
      client.release();
    }
  }

  const deferral = async (workspaceId: string) =>
    (await db.query<{ retention_purge_not_before: Date | null }>("SELECT retention_purge_not_before FROM workspaces WHERE id = $1", [workspaceId])).rows[0]!.retention_purge_not_before;
  const notices = async (workspaceId: string) =>
    (await db.query<{ kind: string; recipient: string; subject: string; text_body: string; sent_at: Date | null }>(
      "SELECT kind, recipient, subject, text_body, sent_at FROM downgrade_notices WHERE workspace_id = $1 ORDER BY created_at",
      [workspaceId],
    )).rows;

  const NOW = new Date("2027-03-01T10:00:00.000Z");

  it("scenario 6 · shortening raw retention records a notice with the exact purge list, defers the first purge to day 15, and sends nothing inline", async () => {
    const ws = await workspace("business"); // raw 395 -> starter 90
    const site = await project(ws, "Acme Site");
    const blog = await project(ws, "Acme Blog");
    // The purge date is NOW + 15 days; the new raw window is 90 days, so the cutoff is NOW + 15d - 90d.
    const cutoff = new Date(NOW.getTime() + RETENTION_FIRST_PURGE_DAYS * DAY - 90 * DAY);
    await capture(ws, site, new Date(cutoff.getTime() - 40 * DAY));
    await capture(ws, site, new Date(cutoff.getTime() - 10 * DAY));
    await capture(ws, site, new Date(cutoff.getTime() - 1 * DAY));
    await capture(ws, blog, new Date(cutoff.getTime() - 5 * DAY));
    await capture(ws, site, new Date(cutoff.getTime() + 1 * DAY)); // inside the new window: NOT named

    const recorded = await record(ws, "business", "starter", "evt_1", NOW);

    expect(await deferral(ws)).toEqual(new Date(NOW.getTime() + 15 * DAY));
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ kind: "retention_shortened", to: "billing@example.com" });
    const [row] = await notices(ws);
    expect(row).toMatchObject({ kind: "retention_shortened", recipient: "billing@example.com", sent_at: null });
    expect(row!.text_body).toContain("Acme Site: 3 captures");
    expect(row!.text_body).toContain("Acme Blog: 1 capture,");
    expect(row!.text_body).toContain("2027-03-16");
    expect(row!.text_body).toMatch(/export/i);
    expect(row!.text_body).toContain("Total: 4 captures");
    expect(row!.text_body, "the in-window capture is not counted").not.toContain("5 captures");
  });

  it("scenario 6 · shortening the rollup window names the daily rollups that will go", async () => {
    const ws = await workspace("growth"); // rollups 730 -> starter 395
    const p = await project(ws, "Rollup Co");
    const cutoffDate = new Date(NOW.getTime() + 15 * DAY - 395 * DAY);
    await metric(ws, p, new Date(cutoffDate.getTime() - 3 * DAY).toISOString().slice(0, 10));
    await metric(ws, p, new Date(cutoffDate.getTime() - 2 * DAY).toISOString().slice(0, 10));
    await metric(ws, p, new Date(cutoffDate.getTime() + 2 * DAY).toISOString().slice(0, 10));

    await record(ws, "growth", "starter", "evt_r", NOW);

    const [row] = await notices(ws);
    expect(row!.text_body).toContain("Rollup Co: 2 days");
    expect(await deferral(ws)).not.toBeNull();
  });

  it("scenario 6 · nothing older than the new window: the notice still goes, says so, and the first purge is still deferred", async () => {
    const ws = await workspace("business");
    await project(ws, "Young");
    const recorded = await record(ws, "business", "starter", "evt_empty", NOW);
    expect(recorded).toHaveLength(1);
    expect((await notices(ws))[0]!.text_body).toMatch(/no existing .* older than/i);
    expect(await deferral(ws)).toEqual(new Date(NOW.getTime() + 15 * DAY));
  });

  it("R1 · a plan change that does not shorten retention records nothing and defers nothing", async () => {
    const up = await workspace("starter");
    expect(await record(up, "starter", "business", "evt_up", NOW)).toEqual([]);
    const same = await workspace("starter");
    expect(await record(same, "starter", "starter", "evt_same", NOW)).toEqual([]);
    for (const ws of [up, same]) {
      expect(await notices(ws)).toEqual([]);
      expect(await deferral(ws)).toBeNull();
    }
  });

  it("R1 · an upgrade off the free tier (rollups \"—\", raw 30 -> longer) is not a shortening: no notice, no deferral", async () => {
    const ws = await workspace("free");
    expect(await record(ws, "free", "starter", "evt_free_up", NOW)).toEqual([]);
    expect(await notices(ws)).toEqual([]);
    expect(await deferral(ws)).toBeNull();
  });

  it("R1 · the replaced plan's windows are stored with the deferral; a second shortening keeps the LONGER of the two", async () => {
    const ws = await workspace("business");
    await record(ws, "business", "starter", "evt_w1", NOW);
    const windows = async () => (await db.query<{ r: number | null; u: number | null }>("SELECT retention_deferred_raw_days AS r, retention_deferred_rollups_days AS u FROM workspaces WHERE id = $1", [ws])).rows[0]!;
    expect(await windows()).toEqual({ r: 395, u: 1095 });
    await record(ws, "starter", "free", "evt_w2", new Date(NOW.getTime() + DAY)); // free: raw 30, rollups "-"
    expect(await windows(), "starter's 90/395 is shorter than the 395/1095 already being kept").toEqual({ r: 395, u: 1095 });
  });

  it("R1 · a shortening after an EXPIRED deferral starts from the plan being left, not the stale stored windows", async () => {
    const ws = await workspace("starter");
    await db.query("UPDATE workspaces SET retention_purge_not_before = $2, retention_deferred_raw_days = 395, retention_deferred_rollups_days = 1095 WHERE id = $1", [ws, new Date(NOW.getTime() - DAY)]);
    await record(ws, "starter", "free", "evt_stale", NOW);
    const row = (await db.query<{ r: number | null }>("SELECT retention_deferred_raw_days AS r FROM workspaces WHERE id = $1", [ws])).rows[0]!;
    expect(row.r).toBe(90);
  });

  it("R1 · no billing contact: the deferral is audited, and a redelivered event does not push the date out again", async () => {
    const ws = await workspace("business", null);
    await record(ws, "business", "starter", "evt_nobody_2", NOW);
    const first = await deferral(ws);
    await record(ws, "business", "starter", "evt_nobody_2", new Date(NOW.getTime() + 3 * DAY));
    expect(await deferral(ws)).toEqual(first);
    const audit = await db.query("SELECT 1 FROM audit_log WHERE workspace_id = $1 AND action = 'billing.retention.shortened' AND request_id = 'evt_nobody_2'", [ws]);
    expect(audit.rowCount, "one audit row, not one per delivery").toBe(1);
  });

  it("R1 · the rollup section also names attribution_daily days, and the email names the derived analyses", async () => {
    const ws = await workspace("growth"); // rollups 730 -> starter 395
    const p = await project(ws, "Attr Co");
    const cutoffDate = new Date(NOW.getTime() + 15 * DAY - 395 * DAY);
    const d = new Date(cutoffDate.getTime() - 5 * DAY).toISOString().slice(0, 10);
    await db.query(
      "INSERT INTO attribution_daily (workspace_id, project_id, metric_date, landing_url_hash, landing_url, referrer_class, country, device) VALUES ($1, $2, $3, decode('01','hex'), 'https://example.com/a', 'chatgpt', 'US', 'desktop')",
      [ws, p, d],
    );
    await record(ws, "growth", "starter", "evt_attr", NOW);
    const body = (await notices(ws))[0]!.text_body;
    expect(body).toContain("Attr Co: 1 day");
    expect(body).toMatch(/attribution/i);
    expect(body).toMatch(/geo analyses/i);
  });

  it("observability · one span, one counted outcome and one log line carrying the workspace ID (never its name, the address or the body)", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    trace.setGlobalTracerProvider(provider);
    const lines: unknown[] = [];
    const spy = vi.spyOn(Logger.prototype, "log").mockImplementation((message: unknown) => void lines.push(message));
    try {
      const ws = await workspace("business", "secret-person@example.com");
      await project(ws, "Confidential Project Name");
      await record(ws, "business", "starter", "evt_obs", NOW);
      const span = exporter.getFinishedSpans().find((sp) => sp.name === "billing.retention_notice.record");
      expect(span, "the record step runs in its own span").toBeDefined();
      expect(span!.attributes["nominara.retention_notice.raw_shortened"]).toBe(true);
      expect(lines).toContainEqual({ metric: "nominara_retention_notice_total", value: 1, outcome: "recorded" });
      const log = lines.find((l) => typeof l === "object" && l !== null && (l as { message?: string }).message?.startsWith("retention shortened: notice recorded")) as Record<string, unknown> | undefined;
      expect(log).toMatchObject({ workspace_id: ws });
      const rendered = JSON.stringify(log);
      expect(rendered).not.toContain("secret-person");
      expect(rendered).not.toContain("Confidential Project Name");
    } finally {
      spy.mockRestore();
      await provider.shutdown();
      trace.disable();
    }
  });

  it("R1 · a redelivered event records one notice and does not push the deferral out again", async () => {
    const ws = await workspace("business");
    await project(ws, "P");
    await record(ws, "business", "starter", "evt_dup", NOW);
    const later = new Date(NOW.getTime() + 2 * DAY);
    const again = await record(ws, "business", "starter", "evt_dup", later);
    expect(again).toEqual([]);
    expect(await notices(ws)).toHaveLength(1);
    expect(await deferral(ws)).toEqual(new Date(NOW.getTime() + 15 * DAY));
  });

  it("R1 · no billing contact: no email, but the first purge is STILL deferred (the data is protected even when nobody can be told)", async () => {
    const ws = await workspace("business", null);
    const recorded = await record(ws, "business", "starter", "evt_nobody", NOW);
    expect(recorded).toEqual([]);
    expect(await notices(ws)).toEqual([]);
    expect(await deferral(ws)).toEqual(new Date(NOW.getTime() + 15 * DAY));
  });

  it("R1 · a second shortening during a deferral never brings the first purge earlier", async () => {
    const ws = await workspace("business");
    await db.query("UPDATE workspaces SET retention_purge_not_before = $2 WHERE id = $1", [ws, new Date(NOW.getTime() + 40 * DAY)]);
    await record(ws, "business", "starter", "evt_second", NOW);
    expect(await deferral(ws)).toEqual(new Date(NOW.getTime() + 40 * DAY));
  });

  it("R1 · the notice is invisible to another tenant (FORCE RLS on the outbox row)", async () => {
    const a = await workspace("business");
    const b = await workspace("business");
    await project(a, "A");
    await record(a, "business", "starter", "evt_rls", NOW);
    const client = await pool.connect();
    try {
      const seen = await withTenantContext(client, { workspaceId: b, actorId: SYSTEM_ACTOR_ID }, (tx) => tx.query("SELECT 1 FROM downgrade_notices WHERE workspace_id = $1", [a]));
      expect(seen.rowCount).toBe(0);
    } finally {
      client.release();
    }
  });

  describe("the deferral in the nightly sweep (owner connection)", () => {
    it("R1 · a deferred workspace loses nothing until the purge date; one second after it, the shorter window applies", async () => {
      const ws = await workspace("starter"); // raw 90
      const p = await project(ws, "P");
      const old = await capture(ws, p, new Date(NOW.getTime() - 200 * DAY));
      await metric(ws, p, "2020-01-01");
      const until = new Date(NOW.getTime() + 15 * DAY);
      await db.query("UPDATE workspaces SET retention_purge_not_before = $2 WHERE id = $1", [ws, until]);

      const during = await runNightlySweep(db, NOW);
      const key = async () => (await db.query<{ raw_object_key: string | null }>("SELECT raw_object_key FROM answer_captures WHERE id = $1", [old])).rows[0]!.raw_object_key;
      expect(await key(), "raw capture kept while deferred").not.toBeNull();
      expect((await db.query("SELECT 1 FROM metric_daily WHERE workspace_id = $1", [ws])).rowCount, "rollup kept while deferred").toBe(1);
      expect(during.deferredWorkspaces).toBeGreaterThanOrEqual(1);

      await runNightlySweep(db, new Date(until.getTime() + 1000));
      expect(await key(), "purged after the date").toBeNull();
    });

    it("R1 · a deferred workspace still loses what the OLD plan's window already expired (500 day old capture and rollup), and keeps the rest", async () => {
      const ws = await workspace("starter");
      const p = await project(ws, "P");
      const ancient = await capture(ws, p, new Date(NOW.getTime() - 500 * DAY)); // past 395: gone under the old plan too
      const aged = await capture(ws, p, new Date(NOW.getTime() - 200 * DAY)); // past 90 (new) but inside 395 (old): kept until the date
      await metric(ws, p, new Date(NOW.getTime() - 1200 * DAY).toISOString().slice(0, 10)); // past the old 1095 rollup window
      await metric(ws, p, new Date(NOW.getTime() - 200 * DAY).toISOString().slice(0, 10));
      await db.query("UPDATE workspaces SET retention_purge_not_before = $2, retention_deferred_raw_days = 395, retention_deferred_rollups_days = 1095 WHERE id = $1", [ws, new Date(NOW.getTime() + 15 * DAY)]);
      await runNightlySweep(db, NOW);
      const key = async (id: string) => (await db.query<{ raw_object_key: string | null }>("SELECT raw_object_key FROM answer_captures WHERE id = $1", [id])).rows[0]!.raw_object_key;
      expect(await key(ancient), "old window still enforced").toBeNull();
      expect(await key(aged), "new window not applied yet").not.toBeNull();
      expect((await db.query("SELECT 1 FROM metric_daily WHERE workspace_id = $1", [ws])).rowCount).toBe(1);
    });

    it("R1 · the instant of the purge date itself is still deferred (strictly after, never at)", async () => {
      const ws = await workspace("starter");
      const p = await project(ws, "P");
      const old = await capture(ws, p, new Date(NOW.getTime() - 200 * DAY));
      await db.query("UPDATE workspaces SET retention_purge_not_before = $2 WHERE id = $1", [ws, NOW]);
      await runNightlySweep(db, NOW);
      expect((await db.query<{ raw_object_key: string | null }>("SELECT raw_object_key FROM answer_captures WHERE id = $1", [old])).rows[0]!.raw_object_key).not.toBeNull();
    });

    it("R1 · the deferral is per workspace: a neighbour with no deferral is purged in the same sweep", async () => {
      const deferred = await workspace("starter");
      const neighbour = await workspace("starter");
      const pd = await project(deferred, "D");
      const pn = await project(neighbour, "N");
      const d = await capture(deferred, pd, new Date(NOW.getTime() - 200 * DAY));
      const n = await capture(neighbour, pn, new Date(NOW.getTime() - 200 * DAY));
      await db.query("UPDATE workspaces SET retention_purge_not_before = $2 WHERE id = $1", [deferred, new Date(NOW.getTime() + 15 * DAY)]);
      await runNightlySweep(db, NOW);
      const keys = await db.query<{ id: string; raw_object_key: string | null }>("SELECT id, raw_object_key FROM answer_captures WHERE id = ANY($1)", [[d, n]]);
      expect(keys.rows.find((r) => r.id === d)!.raw_object_key).not.toBeNull();
      expect(keys.rows.find((r) => r.id === n)!.raw_object_key).toBeNull();
    });

    it("R1 · a deferral in the past (or null) changes nothing: the sweep purges exactly as before", async () => {
      const ws = await workspace("starter");
      const p = await project(ws, "P");
      const c = await capture(ws, p, new Date(NOW.getTime() - 200 * DAY));
      await db.query("UPDATE workspaces SET retention_purge_not_before = $2 WHERE id = $1", [ws, new Date(NOW.getTime() - DAY)]);
      await runNightlySweep(db, NOW);
      expect((await db.query<{ raw_object_key: string | null }>("SELECT raw_object_key FROM answer_captures WHERE id = $1", [c])).rows[0]!.raw_object_key).toBeNull();
    });

    it("R2 · rollups outlive raw: a capture past the raw window loses its text while its rollup row stays", async () => {
      const ws = await workspace("starter"); // raw 90, rollups 395
      const p = await project(ws, "P");
      const c = await capture(ws, p, new Date(NOW.getTime() - 200 * DAY));
      await metric(ws, p, new Date(NOW.getTime() - 200 * DAY).toISOString().slice(0, 10));
      await runNightlySweep(db, NOW);
      expect((await db.query<{ raw_object_key: string | null }>("SELECT raw_object_key FROM answer_captures WHERE id = $1", [c])).rows[0]!.raw_object_key).toBeNull();
      expect((await db.query("SELECT 1 FROM metric_daily WHERE workspace_id = $1", [ws])).rowCount).toBe(1);
    });
  });

  describe("the deferral on the read paths", () => {
    it("R1 · while deferred, the read window is the OLD plan's (never none); after the date, the new window", async () => {
      const ws = await workspace("starter");
      const client = await pool.connect();
      try {
        const cutoffOf = async (now: Date) => await withTenantContext(client, { workspaceId: ws, actorId: SYSTEM_ACTOR_ID }, (tx) => rawRetentionCutoff(tx, ws, now));
        // Business (395 raw) -> starter (90 raw): the deferral recorded the window being replaced.
        await db.query("UPDATE workspaces SET retention_purge_not_before = $2, retention_deferred_raw_days = 395, retention_deferred_rollups_days = 1095 WHERE id = $1", [ws, new Date(NOW.getTime() + 15 * DAY)]);
        expect(await cutoffOf(NOW)).toEqual(new Date(NOW.getTime() - 395 * DAY));
        expect(await cutoffOf(new Date(NOW.getTime() + 16 * DAY))).toEqual(new Date(NOW.getTime() + 16 * DAY - 90 * DAY));
      } finally {
        client.release();
      }
    });

    it("R1 · starter -> free: during the deferral a capture 120 days old stays hidden by the OLD (90 day) window, not readable again", async () => {
      const ws = await workspace("starter");
      await project(ws, "P");
      await record(ws, "starter", "free", "evt_s2f", NOW);
      await db.query("UPDATE workspaces SET plan_key = 'free' WHERE id = $1", [ws]);
      const client = await pool.connect();
      try {
        const cutoff = await withTenantContext(client, { workspaceId: ws, actorId: SYSTEM_ACTOR_ID }, (tx) => rawRetentionCutoff(tx, ws, NOW));
        expect(cutoff, "the old (starter) 90-day window, which is longer than free's 30").toEqual(new Date(NOW.getTime() - 90 * DAY));
      } finally {
        client.release();
      }
    });

    it("R1 · resolveWorkspaceRetention reports the deferral (null when none)", async () => {
      const ws = await workspace("starter");
      expect((await resolveWorkspaceRetention(db, ws)).purgeNotBefore).toBeNull();
      const t = new Date(NOW.getTime() + DAY);
      await db.query("UPDATE workspaces SET retention_purge_not_before = $2 WHERE id = $1", [ws, t]);
      expect((await resolveWorkspaceRetention(db, ws)).purgeNotBefore).toEqual(t);
    });
  });
});
