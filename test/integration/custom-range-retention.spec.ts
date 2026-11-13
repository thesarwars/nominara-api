import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertCustomRangeAllowed } from "../../src/lib/analytics/custom-range.js";
import { MIGRATIONS_DIR, migrateUp } from "../../src/db/migrate-runner.js";
import { expireRollups } from "../../src/workers/rollup/retention.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";

// STORY-090 AC9 - the custom range's lower bound is the day the retention sweep stops deleting at. Run at ONE instant, the sweep (expireRollups) and the read
// (assertCustomRangeAllowed) must agree for every day, in a timezone WEST of UTC between 00:00Z and local midnight, where the local date lags the UTC date.
const N = 395;
// 2026-11-14 04:00Z = 2026-11-13 20:00 in America/Los_Angeles (PST, UTC-8).
const INSTANT = new Date("2026-11-14T04:00:00Z");

describe("STORY-090 AC9 · the read and the sweep draw the retention line on the same day", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18").withDatabase("nominara_test").withUsername("nominara").withPassword("nominara").start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await migrateUp(db, MIGRATIONS_DIR);
  }, 300_000);
  afterAll(async () => {
    await db.end();
    await container.stop();
  });

  it("for America/Los_Angeles at 20:00 local, every day the sweep keeps is readable and every day it deleted is refused", async () => {
    const workspaceId = randomUUID();
    const projectId = randomUUID();
    await db.query("INSERT INTO workspaces (id, name, slug, plan_key, timezone) VALUES ($1,'W',$2,'starter','America/Los_Angeles')", [workspaceId, `w-${workspaceId.slice(0, 8)}`]);
    await db.query("INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain) VALUES ($1,$2,'P',$3,'https://e.test','e.test')", [projectId, workspaceId, `p-${projectId.slice(0, 8)}`]);
    const days = ["2025-10-13", "2025-10-14", "2025-10-15", "2025-10-16"];
    for (const day of days) {
      await db.query("INSERT INTO metric_daily (workspace_id, project_id, engine_key, entity_type, entity_id, metric_date) VALUES ($1,$2,'chatgpt','brand',gen_random_uuid(),$3)", [workspaceId, projectId, day]);
    }
    await expireRollups(db, workspaceId, N, INSTANT);
    const kept = new Set((await db.query<{ d: string }>("SELECT to_char(metric_date,'YYYY-MM-DD') AS d FROM metric_daily WHERE workspace_id = $1", [workspaceId])).rows.map((r) => r.d));
    expect([...kept].sort(), "the sweep keeps from the UTC-cutoff date on").toEqual(["2025-10-15", "2025-10-16"]);

    for (const day of days) {
      const allowed = await withTenantContext(db, { workspaceId, actorId: randomUUID() }, async (tx) => {
        try {
          await assertCustomRangeAllowed(tx, workspaceId, "America/Los_Angeles", { from: day, to: day }, "test", INSTANT);
          return true;
        } catch {
          return false;
        }
      });
      expect(allowed, `${day}: the read must serve it exactly when the sweep kept it`).toBe(kept.has(day));
    }
  });
});
