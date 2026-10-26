import { createHash, randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { Job } from "bullmq";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { DEMO_SEED_MARKER } from "../../src/db/seed/demo/constants.js";
import { uuidV7 } from "../../src/lib/ids/uuidv7.js";
import type { QueueHandlerContext } from "../../src/lib/queue/handlers.js";
import { createRollupMetricDailyHandler } from "../../src/lib/queue/handlers/rollup-metric-daily.handler.js";
import { GrowthMapService } from "../../src/modules/analytics/growth-map.service.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";

// STORY-066 AC7–AC10, scenarios 7, 8, 9, 10, 11 — the two configuration pins the
// rollup emits: `engine_model_change` (a vendor-reported model fingerprint
// changed) and `prompt_set_change` (≥ 10 % of the prompt set added or removed in
// one day). Both are idempotent by a deterministic source id, so a rollup re-run
// cannot double-pin, and both are driven through the REAL rollup handler.

const DAY = 86_400_000;

describe("STORY-066 · configuration milestones from the rollup", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let workspaceId: string;
  let projectId: string;

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

  beforeEach(async () => {
    await db.query("TRUNCATE milestones, metric_daily, answer_captures, tracked_prompts, projects, workspaces CASCADE");
    workspaceId = randomUUID();
    projectId = randomUUID();
    await db.query("INSERT INTO workspaces (id,name,slug,plan_key,timezone) VALUES ($1,'W',$2,'growth','UTC')", [workspaceId, `w-${workspaceId.slice(0, 8)}`]);
    await db.query(
      `INSERT INTO projects (id,workspace_id,name,slug,root_url,root_domain) VALUES ($1,$2,'Acme',$3,'https://acme.com','acme.com')`,
      [projectId, workspaceId, `p-${projectId.slice(0, 8)}`],
    );
  });

  const today = (): string => new Date().toISOString().slice(0, 10);
  const daysAgo = (n: number, hour = 12): string => `${new Date(Date.now() - n * DAY).toISOString().slice(0, 10)}T${String(hour).padStart(2, "0")}:00:00Z`;

  async function capture(at: string, engineKey: string, fingerprint: string | null, normalizer = "n1"): Promise<void> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO answer_captures (id,workspace_id,project_id,run_id,prompt_id,engine_key,captured_at,capture_mode,adapter_version,
                                    normalizer_version,model_fingerprint,content_hash,status,brand_present)
       VALUES ($1,$2,$3,$4,$5,$6,$7::timestamptz,'api','1.0.0',$8,$9,$10,'parsed',false)`,
      [id, workspaceId, projectId, uuidV7(), randomUUID(), engineKey, at, normalizer, fingerprint, createHash("sha256").update(id).digest()],
    );
  }

  async function prompts(count: number, createdAt: string, extra: { status?: string; deletedAt?: string } = {}): Promise<void> {
    for (let i = 0; i < count; i += 1) {
      const text = `q-${randomUUID()}`;
      await db.query(
        `INSERT INTO tracked_prompts (workspace_id,project_id,text,text_hash,intent_archetype,funnel_stage,status,created_at,updated_at,deleted_at)
         VALUES ($1,$2,$3::text,sha256(convert_to($3::text, 'UTF8')),'recommendation','consideration',$4,$5::timestamptz,$5::timestamptz,$6::timestamptz)`,
        [workspaceId, projectId, text, extra.status ?? "active", createdAt, extra.deletedAt ?? null],
      );
    }
  }

  /** One run of the real `rollup.metric_daily` handler for `metricDate`, in the tenant's context. */
  async function rollup(metricDate = today()): Promise<void> {
    const handler = createRollupMetricDailyHandler({ pool: undefined, env: {} } as unknown as QueueHandlerContext, {
      enqueueVerifyPresence: async () => undefined,
      enqueueTaskGenerate: async () => undefined,
    });
    const job = { data: { payload: { workspaceId, kid: "k", projectId, metricDate } } } as unknown as Job;
    await withTenantContext(db, { workspaceId, actorId: randomUUID() }, (tx) => handler(tx, job));
  }

  const pins = async (kind: string) =>
    (
      await db.query<{
        kind: string;
        title: string;
        detail: string | null;
        severity: string;
        source_type: string | null;
        source_id: string | null;
        affected_engines: string[];
        visible_in_portal: boolean;
        occurred_at: Date;
      }>(
        `SELECT kind, title, detail, severity, source_type, source_id::text, affected_engines, visible_in_portal, occurred_at
           FROM milestones WHERE project_id = $1 AND kind = $2 ORDER BY occurred_at`,
        [projectId, kind],
      )
    ).rows;

  describe("engine_model_change", () => {
    it("scenario 10 — a fingerprint change pins a warning, portal-hidden, naming the engine, at the first capture under the new model", async () => {
      await capture(daysAgo(1), "gemini", "gemini-2.5-flash-001");
      await capture(daysAgo(0, 1), "gemini", "gemini-2.5-flash-001");
      await capture(daysAgo(0, 3), "gemini", "gemini-2.5-flash-002");
      await rollup();

      const [pin, ...rest] = await pins("engine_model_change");
      expect(rest).toEqual([]);
      expect(pin).toMatchObject({
        severity: "warning",
        visible_in_portal: false,
        affected_engines: ["gemini"],
        source_type: "system",
        detail: "gemini-2.5-flash-001 to gemini-2.5-flash-002",
      });
      expect(pin!.source_id).not.toBeNull();
      expect(pin!.occurred_at.toISOString()).toBe(new Date(daysAgo(0, 3)).toISOString());
    });

    it("scenario 10 — the chart crossing the date carries the pin; scenario 11 — the portal's read never does", async () => {
      await capture(daysAgo(2), "gemini", "a");
      await capture(daysAgo(1), "gemini", "b");
      await rollup(daysAgo(1).slice(0, 10));

      const agency = await withTenantContext(db, { workspaceId, actorId: randomUUID() }, () => new GrowthMapService().growthMap(projectId, { timeframe: "7d" }));
      expect(agency.milestones.map((m) => m.kind)).toContain("engine_model_change");
      const portal = await withTenantContext(db, { workspaceId, actorId: randomUUID() }, () =>
        new GrowthMapService().growthMap(projectId, { timeframe: "7d" }, { days: 7, portal: { hideCompetitors: false, timezone: "UTC" } }),
      );
      expect(portal.milestones.map((m) => m.kind)).not.toContain("engine_model_change");
    });

    it("scenario 8 — re-running the rollup (and rolling up the next day) cannot double-pin", async () => {
      await capture(daysAgo(1), "gemini", "a");
      await capture(daysAgo(0, 2), "gemini", "b");
      await rollup();
      await rollup();
      await capture(daysAgo(0, 4), "gemini", "b");
      await rollup();
      expect(await pins("engine_model_change")).toHaveLength(1);
    });

    it("AC7 — a capture committed AFTER a rollup but captured EARLIER (concurrent capture workers) cannot pin the same change twice; the pin moves to the earlier instant", async () => {
      await capture(daysAgo(1), "gemini", "a");
      await capture(daysAgo(0, 3), "gemini", "b");
      await rollup();
      await capture(daysAgo(0, 2), "gemini", "b"); // committed late, captured before the first "b"
      await rollup();
      const all = await pins("engine_model_change");
      expect(all).toHaveLength(1);
      expect(all[0]!.occurred_at.toISOString()).toBe(new Date(daysAgo(0, 2)).toISOString());
    });

    it("AC7 — a vendor whose fingerprint flips back and forth pins each distinct change once a day, not once per flip", async () => {
      await capture(daysAgo(1), "gemini", "a");
      await capture(daysAgo(0, 1), "gemini", "b");
      await capture(daysAgo(0, 2), "gemini", "a");
      await capture(daysAgo(0, 3), "gemini", "b");
      await rollup();
      expect((await pins("engine_model_change")).map((p) => p.detail)).toEqual(["a to b", "b to a"]);
    });

    it("the first fingerprint ever seen, an unchanged one, a missing one and a demo-seeded capture pin nothing", async () => {
      await capture(daysAgo(0, 1), "gemini", "a");
      await capture(daysAgo(0, 2), "gemini", null);
      await capture(daysAgo(0, 3), "gemini", "a");
      await capture(daysAgo(0, 4), "chatgpt", "demo-model", DEMO_SEED_MARKER);
      await capture(daysAgo(0, 5), "chatgpt", "other-demo-model", DEMO_SEED_MARKER);
      await rollup();
      expect(await pins("engine_model_change")).toEqual([]);
    });

    it("each engine is tracked on its own", async () => {
      await capture(daysAgo(1), "gemini", "g1");
      await capture(daysAgo(1), "perplexity", "p1");
      await capture(daysAgo(0, 2), "gemini", "g2");
      await capture(daysAgo(0, 2), "perplexity", "p1");
      await rollup();
      expect((await pins("engine_model_change")).map((p) => p.affected_engines)).toEqual([["gemini"]]);
    });
  });

  describe("prompt_set_change", () => {
    it("scenario 9-style — 10 % of the set added in one day pins a visible configuration marker", async () => {
      await prompts(10, daysAgo(5));
      await prompts(1, daysAgo(0, 2));
      await rollup();
      const [pin, ...rest] = await pins("prompt_set_change");
      expect(rest).toEqual([]);
      expect(pin).toMatchObject({ severity: "info", source_type: "system", visible_in_portal: true });
      expect(pin!.detail).toBe("1 added, 0 removed of 10");
    });

    it("10 % removed in one day (deleted or archived) pins too", async () => {
      await prompts(18, daysAgo(5));
      await prompts(1, daysAgo(5), { deletedAt: daysAgo(0, 2) });
      await prompts(1, daysAgo(5), { status: "archived" });
      await db.query("UPDATE tracked_prompts SET updated_at = $2::timestamptz WHERE project_id = $1 AND status = 'archived'", [projectId, daysAgo(0, 3)]);
      await rollup();
      expect((await pins("prompt_set_change")).map((p) => p.detail)).toEqual(["0 added, 2 removed of 20"]);
    });

    it("below 10 %, or a project's first prompt set, pins nothing", async () => {
      await prompts(20, daysAgo(0, 1));
      await rollup();
      expect(await pins("prompt_set_change")).toEqual([]);
      await db.query("UPDATE tracked_prompts SET created_at = created_at - interval '5 days' WHERE project_id = $1", [projectId]);
      await prompts(1, daysAgo(0, 2));
      await rollup();
      expect(await pins("prompt_set_change")).toEqual([]);
    });

    it("scenario 8 — re-running the rollup cannot double-pin", async () => {
      await prompts(10, daysAgo(5));
      await prompts(2, daysAgo(0, 2));
      await rollup();
      await rollup();
      expect(await pins("prompt_set_change")).toHaveLength(1);
    });
  });
});
