import { createHash, randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { refreshProjectSourceIndex } from "../../src/lib/rollup/refresh-project-source-index.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";
import type { GuardedResponse } from "../../src/lib/net/guarded-fetch.js";
import { verifyProjectSourcePresence } from "../../src/lib/sources/verify-presence.js";

// NEW-C-15 / STORY-054 AC4 + AC11, scenarios 5, 6, 7: presence verified by
// fetching the cited URL through the guarded fetcher (faked here — no network)
// and matching the brand's aliases; cached 30 days; a failed fetch stays null;
// a demo `.example` domain and a domain cited only by a demo engine never
// verify. Tenant isolation is proven under SET ROLE nominara_app.

const TODAY = "2026-10-07";
const NOW = new Date("2026-10-08T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

const html = (text: string): GuardedResponse => ({
  status: 200,
  headers: { "content-type": "text/html" },
  body: Buffer.from(`<html><body><p>${text}</p></body></html>`),
  finalUrl: "https://x.test/",
});

interface Presence {
  domain: string;
  engine_key: string;
  window_days: number;
  brand_present_on_domain: boolean | null;
  verified_at: Date | null;
  gap_severity: string | null;
}

describe("NEW-C-15 · verifyProjectSourcePresence", () => {
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
    await db.query("TRUNCATE citation_facts, project_source_index, source_domains, projects, workspaces CASCADE");
    workspaceId = randomUUID();
    projectId = randomUUID();
    await db.query("INSERT INTO workspaces (id, name, slug, plan_key, timezone) VALUES ($1,'W',$2,'growth','UTC')", [workspaceId, `w-${workspaceId.slice(0, 8)}`]);
    await db.query(
      `INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain, brand_aliases, negative_aliases)
       VALUES ($1,$2,'Acme Analytics',$3,'https://acme.com','acme.com','{Acme}','{}')`,
      [projectId, workspaceId, `p-${projectId.slice(0, 8)}`],
    );
  });

  async function cite(domain: string, prompt: number, engine = "gemini"): Promise<void> {
    const url = `https://${domain}/best`;
    await db.query(
      `INSERT INTO citation_facts
         (workspace_id, project_id, result_id, prompt_id, engine_key, captured_at, slot_index, raw_url, normalized_url,
          url_hash, domain, is_owned, is_competitor, source_class, http_status, position_weight)
       VALUES ($1,$2,$3,$4,$5, $6::date - 1 + interval '12 hours', 1,$7,$7,$8,$9,false,false,'community_forum',200,1)`,
      [workspaceId, projectId, randomUUID(), randomUUID(), engine, TODAY, url, createHash("sha256").update(url + prompt).digest(), domain],
    );
  }

  async function reindex(): Promise<void> {
    await db.query("BEGIN");
    await refreshProjectSourceIndex(db, projectId, TODAY);
    await db.query("COMMIT");
  }

  const verify = (fetch: (url: string) => Promise<GuardedResponse>, now = NOW) =>
    withTenantContext(db, { workspaceId, actorId: randomUUID() }, (tx) => verifyProjectSourcePresence(tx, projectId, { fetch, now }));

  async function rows(domain?: string): Promise<Presence[]> {
    return (
      await db.query(
        `SELECT sd.domain, psi.engine_key, psi.window_days, psi.brand_present_on_domain, psi.verified_at, psi.gap_severity
           FROM project_source_index psi JOIN source_domains sd ON sd.id = psi.source_domain_id
          WHERE psi.project_id = $1 AND ($2::text IS NULL OR sd.domain = $2) ORDER BY sd.domain, psi.engine_key, psi.window_days`,
        [projectId, domain ?? null],
      )
    ).rows as Presence[];
  }

  it("STORY-054 scenario 5: the brand is on the fetched page, so every index row for the domain records present with verified_at", async () => {
    for (let i = 0; i < 6; i++) await cite("reviews.test", i);
    await reindex();
    expect((await rows("reviews.test")).every((r) => r.brand_present_on_domain === null && r.verified_at === null)).toBe(true);
    const fetch = vi.fn().mockResolvedValue(html("Acme Analytics is the best."));
    const summary = await verify(fetch);
    expect(fetch).toHaveBeenCalledWith("https://reviews.test/best");
    expect(summary).toMatchObject({ present: 1, absent: 0, failed: 0 });
    const after = await rows("reviews.test");
    expect(after.length).toBeGreaterThan(1);
    for (const r of after) {
      expect(r.brand_present_on_domain).toBe(true);
      expect(r.verified_at).not.toBeNull();
    }
  });

  it("STORY-054 scenario 6: the brand is absent on the fetched page, so absence is verified false and the gap severity is computed", async () => {
    for (let i = 0; i < 6; i++) await cite("reviews.test", i);
    await reindex();
    const summary = await verify(vi.fn().mockResolvedValue(html("Only Globex here.")));
    expect(summary).toMatchObject({ present: 0, absent: 1, failed: 0 });
    const all30 = (await rows("reviews.test")).find((r) => r.engine_key === "all" && r.window_days === 30)!;
    expect(all30.brand_present_on_domain).toBe(false);
    expect(all30.verified_at).not.toBeNull();
    expect(all30.gap_severity).toBe("critical");
  });

  it("STORY-054 scenario 7: a second run inside the 30-day window does not fetch again", async () => {
    await cite("reviews.test", 1);
    await reindex();
    const fetch = vi.fn().mockResolvedValue(html("Acme Analytics"));
    await verify(fetch);
    expect(fetch).toHaveBeenCalledTimes(1);
    const second = await verify(fetch, new Date(NOW.getTime() + 29 * DAY));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(second).toMatchObject({ checked: 0, skipped: { cached: 1 } });
  });

  it("STORY-054 scenario 7: after the window the domain is fetched again", async () => {
    await cite("reviews.test", 1);
    await reindex();
    const fetch = vi.fn().mockResolvedValue(html("Acme Analytics"));
    await verify(fetch);
    await verify(fetch, new Date(NOW.getTime() + 31 * DAY));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("STORY-054 AC4: a fetch failure stays null (never an asserted absence) and writes no verified_at", async () => {
    await cite("reviews.test", 1);
    await reindex();
    const summary = await verify(vi.fn().mockRejectedValue(new Error("ECONNRESET")));
    expect(summary).toMatchObject({ present: 0, absent: 0, failed: 1 });
    for (const r of await rows("reviews.test")) {
      expect(r.brand_present_on_domain).toBeNull();
      expect(r.verified_at).toBeNull();
      expect(r.gap_severity).toBeNull();
    }
  });

  it("STORY-054 AC4: a failed re-check does not erase an earlier verified value", async () => {
    await cite("reviews.test", 1);
    await reindex();
    await verify(vi.fn().mockResolvedValue(html("Acme Analytics")));
    const failing = vi.fn().mockResolvedValue({ ...html(""), status: 503 });
    await verify(failing, new Date(NOW.getTime() + 40 * DAY));
    expect(failing).toHaveBeenCalledTimes(1);
    for (const r of await rows("reviews.test")) expect(r.brand_present_on_domain).toBe(true);
  });

  it("NEW-C-15: a demo .example domain is never fetched and stays unverified (null)", async () => {
    await cite("acme-io.community-forum.example", 1);
    await reindex();
    const fetch = vi.fn();
    const summary = await verify(fetch);
    expect(fetch).not.toHaveBeenCalled();
    expect(summary.skipped.demo).toBe(1);
    for (const r of await rows()) expect(r.brand_present_on_domain).toBeNull();
  });

  it("NEW-C-15: a real-looking domain cited only by a demo engine is not fetched; only a live engine's citation verifies", async () => {
    await cite("reviews.test", 1, "chatgpt");
    await reindex();
    const fetch = vi.fn();
    await verify(fetch);
    expect(fetch).not.toHaveBeenCalled();
    for (const r of await rows()) expect(r.brand_present_on_domain).toBeNull();
  });

  it("empty index: nothing to verify, no fetch, zero counts", async () => {
    const fetch = vi.fn();
    expect(await verify(fetch)).toMatchObject({ checked: 0, present: 0, absent: 0, failed: 0 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("idempotent: re-running with the same fetch result leaves the same rows", async () => {
    await cite("reviews.test", 1);
    await reindex();
    const fetch = vi.fn().mockResolvedValue(html("Acme Analytics"));
    await verify(fetch);
    const before = await rows();
    await verify(fetch);
    expect(await rows()).toEqual(before);
  });

  it("tenant isolation under nominara_app: another workspace's context cannot verify (or fetch for) this project", async () => {
    await cite("reviews.test", 1);
    await reindex();
    const otherWorkspace = randomUUID();
    await db.query("INSERT INTO workspaces (id,name,slug,plan_key,timezone) VALUES ($1,'W2',$2,'growth','UTC')", [otherWorkspace, `w-${randomUUID().slice(0, 8)}`]);
    const fetch = vi.fn();
    await db.query("SET ROLE nominara_app");
    try {
      const result = await withTenantContext(db, { workspaceId: otherWorkspace, actorId: randomUUID() }, (tx) =>
        verifyProjectSourcePresence(tx, projectId, { fetch, now: NOW }),
      );
      expect(result).toBeNull();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      await db.query("RESET ROLE");
    }
    for (const r of await rows()) expect(r.brand_present_on_domain).toBeNull();
  });
});
