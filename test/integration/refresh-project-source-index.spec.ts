import { createHash, randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { SCORING_VERSION } from "../../src/lib/scoring/index.js";
import { refreshProjectSourceIndex } from "../../src/lib/rollup/refresh-project-source-index.js";

// NEW-C-4 / STORY-054 scenarios 1-4, 8-11 (scenarios 5-7, the fetch
// verification, belong to NEW-C-15).

// A version that is NOT the column default ('v1'), so a writer that hard-codes the
// default instead of stamping SCORING_VERSION fails the version test below.
vi.mock("../../src/lib/scoring/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/scoring/index.js")>()),
  SCORING_VERSION: "v-audit-test",
}));

const TODAY = "2026-10-07";
const promptUuid = (name: string): string => {
  const h = createHash("sha256").update(name).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

interface SourceIndexRow {
  domain: string;
  source_class: string;
  is_seedable: boolean;
  engine_key: string;
  window_days: number;
  citation_count: number;
  context_weight: number;
  rank_position: number;
  brand_present_on_domain: boolean | null;
  gap_severity: string | null;
  top_urls: unknown;
}

describe("NEW-C-4 · refreshProjectSourceIndex", () => {
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

  async function newProject(): Promise<{ workspaceId: string; projectId: string }> {
    const ws = randomUUID();
    const pr = randomUUID();
    await db.query("INSERT INTO workspaces (id, name, slug, plan_key, timezone) VALUES ($1,'W',$2,'growth','UTC')", [ws, `w-${ws.slice(0, 8)}`]);
    await db.query(
      `INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain)
       VALUES ($1,$2,'Acme',$3,'https://acme.com','acme.com')`,
      [pr, ws, `p-${pr.slice(0, 8)}`],
    );
    return { workspaceId: ws, projectId: pr };
  }

  beforeEach(async () => {
    await db.query("TRUNCATE citation_facts, project_source_index, source_domains, projects, workspaces CASCADE");
    ({ workspaceId, projectId } = await newProject());
  });

  async function cite(
    over: { ws?: string; pr?: string; domain: string; prompt: string; engine?: string; url?: string; daysAgo?: number; competitor?: boolean; owned?: boolean; sourceClass?: string | null; slot?: number },
  ): Promise<void> {
    const url = over.url ?? `https://${over.domain}/p/${randomUUID().slice(0, 6)}`;
    await db.query(
      `INSERT INTO citation_facts
         (workspace_id, project_id, result_id, prompt_id, engine_key, captured_at, slot_index, raw_url, normalized_url,
          url_hash, domain, is_owned, is_competitor, source_class, http_status, position_weight)
       VALUES ($1,$2,$3,$4,$5, $6::date - $7::int + interval '12 hours', $8,$9,$9,$10,$11,$12,$13,$14,200,$15)`,
      [
        over.ws ?? workspaceId, over.pr ?? projectId, randomUUID(), promptUuid(over.prompt), over.engine ?? "gemini", TODAY, over.daysAgo ?? 1,
        over.slot ?? 1, url, createHash("sha256").update(url).digest(), over.domain, over.owned ?? false, over.competitor ?? false,
        over.sourceClass ?? null, 1 / Math.sqrt(over.slot ?? 1),
      ],
    );
  }

  async function rows(where = "TRUE", pr = projectId): Promise<SourceIndexRow[]> {
    return (
      await db.query(
        `SELECT sd.domain,
                CASE WHEN psi.is_competitor_owned THEN 'vendor_owned' ELSE sd.source_class END AS source_class,
                (sd.is_seedable AND NOT psi.is_competitor_owned) AS is_seedable, psi.engine_key, psi.window_days, psi.window_start::text AS window_start,
                psi.citation_count, psi.distinct_prompts, psi.context_weight, psi.rank_position,
                psi.brand_present_on_domain, psi.gap_severity, psi.top_urls
           FROM project_source_index psi JOIN source_domains sd ON sd.id = psi.source_domain_id
          WHERE psi.project_id = $1 AND ${where} ORDER BY psi.context_weight DESC`,
        [pr],
      )
    ).rows;
  }

  const run = async (): Promise<void> => {
    await db.query("BEGIN");
    await refreshProjectSourceIndex(db, projectId, TODAY);
    await db.query("COMMIT");
  };

  it("STORY-054 #1 · classifies from the curated list and falls back to the heuristic", async () => {
    await cite({ domain: "reddit.com", prompt: "p1" });
    await cite({ domain: "g2.com", prompt: "p1" });
    await cite({ domain: "forum.example.org", prompt: "p1" });
    await cite({ domain: "weird-unknown.io", prompt: "p1" });
    await run();
    const byDomain = Object.fromEntries((await rows("psi.engine_key='all' AND psi.window_days=30")).map((r) => [r.domain, r]));
    expect(byDomain["reddit.com"]!.source_class).toBe("community_forum");
    expect(byDomain["g2.com"]!.source_class).toBe("review_marketplace");
    expect(byDomain["forum.example.org"]!.source_class).toBe("community_forum");
    expect(byDomain["weird-unknown.io"]!.source_class).toBe("other");
    expect(byDomain["reddit.com"]!.is_seedable).toBe(true);
    expect(byDomain["weird-unknown.io"]!.is_seedable).toBe(false);
  });

  it("STORY-054 #2 / AC1 · a heuristically classified domain is flagged class_source='heuristic' for curation; a curated one is 'curated'", async () => {
    await cite({ domain: "reddit.com", prompt: "p1" });
    await cite({ domain: "forum.example.org", prompt: "p1" });
    await cite({ domain: "weird-unknown.io", prompt: "p1" });
    await run();
    const flags = Object.fromEntries(
      (await db.query("SELECT domain, class_source FROM source_domains WHERE workspace_id = $1", [workspaceId])).rows.map((r) => [r.domain, r.class_source]),
    );
    expect(flags).toEqual({ "reddit.com": "curated", "forum.example.org": "heuristic", "weird-unknown.io": "heuristic" });
  });

  it("STORY-054 #2 / AC1 · the flag is recomputed from the domain on every refresh and never accumulates a second row", async () => {
    await cite({ domain: "weird-unknown.io", prompt: "p1" });
    await run();
    await run();
    const found = (await db.query("SELECT class_source FROM source_domains WHERE workspace_id = $1", [workspaceId])).rows;
    expect(found).toEqual([{ class_source: "heuristic" }]);
  });

  it("STORY-054 #3 · a competitor-owned domain is never seedable, even in a seedable class", async () => {
    await cite({ domain: "rival.com", prompt: "p1", competitor: true, sourceClass: "community_forum" });
    await run();
    const [row] = await rows("psi.engine_key='all' AND psi.window_days=30");
    expect(row!.source_class).toBe("vendor_owned");
    expect(row!.is_seedable).toBe(false);
  });

  it("STORY-054 #4 · 40 citations over 25 prompts outrank 40 citations over 2", async () => {
    for (let i = 0; i < 40; i++) await cite({ domain: "broad.example", prompt: `p${i % 25}` });
    for (let i = 0; i < 40; i++) await cite({ domain: "narrow.example", prompt: `p${i % 2}` });
    await run();
    const result = await rows("psi.engine_key='all' AND psi.window_days=30");
    expect(result[0]!.domain).toBe("broad.example");
    expect(result[0]!.rank_position).toBe(1);
    expect(result[1]!.rank_position).toBe(2);
    expect(result.reduce((s, r) => s + r.context_weight, 0)).toBeCloseTo(1, 4);
  });

  it("writes 7, 30 and 90-day windows per engine plus an 'all' row; counts respect the window", async () => {
    await cite({ domain: "a.example", prompt: "p1", engine: "gemini", daysAgo: 2 });
    await cite({ domain: "a.example", prompt: "p1", engine: "chatgpt", daysAgo: 20 });
    await cite({ domain: "a.example", prompt: "p2", engine: "chatgpt", daysAgo: 60 });
    await run();
    const all = await rows("psi.engine_key='all'");
    const count = (days: number) => all.find((r) => r.window_days === days)?.citation_count;
    expect([count(7), count(30), count(90)]).toEqual([1, 2, 3]);
    expect((await rows("psi.engine_key='chatgpt'")).map((r) => r.window_days).sort()).toEqual([30, 90]);
    expect((await rows("psi.engine_key='gemini' AND psi.window_days=7")).length).toBe(1);
  });

  it("excludes the brand's own citations and records top urls with counts and last-seen", async () => {
    await cite({ domain: "acme.com", prompt: "p1", owned: true });
    await cite({ domain: "a.example", prompt: "p1", url: "https://a.example/x", daysAgo: 3 });
    await cite({ domain: "a.example", prompt: "p2", url: "https://a.example/x", daysAgo: 1 });
    await run();
    const result = await rows("psi.engine_key='all' AND psi.window_days=30");
    expect(result.map((r) => r.domain)).toEqual(["a.example"]);
    expect(result[0]!.top_urls).toEqual([{ url: "https://a.example/x", count: 2, last_seen: "2026-10-06" }]);
  });

  it("STORY-054 #8 · high-influence, verified absent, seedable domain is critical", async () => {
    for (let i = 0; i < 6; i++) await cite({ domain: "reddit.com", prompt: `p${i}` });
    await run();
    // Not yet verified: severity is withheld, never assumed.
    expect((await rows("psi.window_days=30 AND psi.engine_key='all'"))[0]!.gap_severity).toBeNull();
    expect((await rows("psi.window_days=30 AND psi.engine_key='all'"))[0]!.brand_present_on_domain).toBeNull();
    await db.query("UPDATE project_source_index SET brand_present_on_domain=false, verified_at=now() WHERE project_id=$1", [projectId]);
    await run(); // recompute keeps the verified presence
    expect((await rows("psi.window_days=30 AND psi.engine_key='all'"))[0]!.gap_severity).toBe("critical");
  });

  it("STORY-054 #9 · same weight on a non-seedable domain stays below the top bands", async () => {
    for (let i = 0; i < 6; i++) await cite({ domain: "arxiv.org", prompt: `p${i}` });
    await run();
    await db.query("UPDATE project_source_index SET brand_present_on_domain=false, verified_at=now() WHERE project_id=$1", [projectId]);
    await run();
    const [row] = await rows("psi.window_days=30 AND psi.engine_key='all'");
    expect(row!.gap_severity).toBe("medium");
  });

  it("audit #1 · a verified-absent, high-influence COMPETITOR-owned domain in a seedable class is never critical/high, and coverage reflects it", async () => {
    for (let i = 0; i < 6; i++) await cite({ domain: "rival.example", prompt: `p${i}`, competitor: true, sourceClass: "community_forum" });
    await run();
    await db.query("UPDATE project_source_index SET brand_present_on_domain=false, verified_at=now() WHERE project_id=$1", [projectId]);
    await run();
    const all = await rows("psi.window_days=30 AND psi.engine_key='all'");
    expect(all).toHaveLength(1);
    expect(all[0]!.is_seedable).toBe(false);
    expect(all[0]!.gap_severity).toBe("medium");
    const every = await rows();
    expect(every.length).toBeGreaterThan(1);
    for (const r of every) expect(["critical", "high"], `${r.engine_key}/${r.window_days}`).not.toContain(r.gap_severity);
    const cov = await db.query("SELECT source_coverage::float8 AS c FROM projects WHERE id=$1", [projectId]);
    expect(cov.rows[0].c).toBeCloseTo(100, 3);
  });

  it("STORY-054 #10 · a recompute replaces rows and drops domains that left the window", async () => {
    await cite({ domain: "a.example", prompt: "p1" });
    await cite({ domain: "b.example", prompt: "p1" });
    await run();
    const first = (await rows()).length;
    await run();
    expect((await rows()).length).toBe(first);
    await db.query("DELETE FROM citation_facts WHERE domain='b.example'");
    await run();
    expect((await rows()).every((r) => r.domain === "a.example")).toBe(true);
  });

  it("STORY-054 #11 · two workspaces citing the same domain get independent source_domains rows", async () => {
    const other = await newProject();
    await cite({ domain: "reddit.com", prompt: "p1" });
    await cite({ domain: "reddit.com", prompt: "p1", ws: other.workspaceId, pr: other.projectId });
    await run();
    await db.query("BEGIN");
    await refreshProjectSourceIndex(db, other.projectId, TODAY);
    await db.query("COMMIT");
    const result = await db.query("SELECT workspace_id FROM source_domains WHERE domain='reddit.com'");
    expect(result.rows.map((r) => r.workspace_id).sort()).toEqual([workspaceId, other.workspaceId].sort());
  });

  it("audit #1 · a domain flagged competitor under only ONE engine is never seedable, whatever the GROUP BY order", async () => {
    // 'aaa' sorts first, so the old first-row-wins loop saw the non-competitor facts.
    await cite({ domain: "z.example", prompt: "p1", engine: "aaa", competitor: false, sourceClass: "community_forum" });
    await cite({ domain: "z.example", prompt: "p2", engine: "zzz", competitor: true, sourceClass: "community_forum" });
    await run();
    const all = await rows("sd.domain='z.example'");
    expect(all.length).toBeGreaterThan(0);
    for (const r of all) {
      expect(r.source_class, `${r.engine_key}/${r.window_days}`).toBe("vendor_owned");
      expect(r.is_seedable, `${r.engine_key}/${r.window_days}`).toBe(false);
    }
  });

  it("audit #2 · competitor status is per project: one project's recompute never flips another's seedability", async () => {
    const bId = randomUUID();
    await db.query(
      `INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain) VALUES ($1,$2,'B',$3,'https://b.com','b.com')`,
      [bId, workspaceId, `p-${bId.slice(0, 8)}`],
    );
    await cite({ domain: "rival.com", prompt: "p1", competitor: true, sourceClass: "community_forum" });
    await cite({ domain: "rival.com", prompt: "p1", pr: bId, competitor: false, sourceClass: "community_forum" });
    await run(); // A
    await db.query("BEGIN");
    await refreshProjectSourceIndex(db, bId, TODAY); // B is the last writer
    await db.query("COMMIT");
    const a = await rows("psi.engine_key='all' AND psi.window_days=30", projectId);
    const b = await rows("psi.engine_key='all' AND psi.window_days=30", bId);
    expect([a[0]!.source_class, a[0]!.is_seedable]).toEqual(["vendor_owned", false]);
    expect([b[0]!.source_class, b[0]!.is_seedable]).toEqual(["community_forum", true]);
    expect(a[0]!.gap_severity).toBeNull(); // unverified: still withheld, and consistent with not-seedable
  });

  it("audit #2 · the shared source_domains row carries the domain's own class, not a project's competitor override", async () => {
    await cite({ domain: "rival.com", prompt: "p1", competitor: true, sourceClass: "community_forum" });
    await run();
    const r = await db.query("SELECT source_class, is_seedable FROM source_domains WHERE domain='rival.com'");
    expect(r.rows[0]).toEqual({ source_class: "community_forum", is_seedable: true });
  });

  it("audit #2 · competitor status is decided once per run: a flag seen only in the 90-day window applies to the 7-day rows", async () => {
    await cite({ domain: "old.example", prompt: "p1", daysAgo: 60, competitor: true, sourceClass: "community_forum" });
    await cite({ domain: "old.example", prompt: "p2", daysAgo: 2, competitor: false, sourceClass: "community_forum" });
    await run();
    const seven = await rows("psi.engine_key='all' AND psi.window_days=7");
    expect([seven[0]!.source_class, seven[0]!.is_seedable]).toEqual(["vendor_owned", false]);
  });

  it("audit #5 · every written row carries the scoring module's SCORING_VERSION", async () => {
    await cite({ domain: "a.example", prompt: "p1" });
    await run();
    const r = await db.query("SELECT DISTINCT scoring_version FROM project_source_index WHERE project_id=$1", [projectId]);
    expect(SCORING_VERSION).toBe("v-audit-test");
    expect(r.rows).toEqual([{ scoring_version: "v-audit-test" }]);
  });

  it("audit #3 · source_coverage is NULL while ANY domain in the window is unverified (partial verification is not 'no gap')", async () => {
    for (let i = 0; i < 8; i++) await cite({ domain: "big.example", prompt: `p${i}` });
    await cite({ domain: "reddit.com", prompt: "p1" });
    await run();
    await db.query(
      `UPDATE project_source_index SET brand_present_on_domain=false, verified_at=now()
        WHERE project_id=$1 AND source_domain_id=(SELECT id FROM source_domains WHERE domain='reddit.com')`,
      [projectId],
    );
    await run();
    const r = await db.query("SELECT source_coverage FROM projects WHERE id=$1", [projectId]);
    expect(r.rows[0].source_coverage).toBeNull();
  });

  it("audit #3 · once every domain is verified, source_coverage is published", async () => {
    for (let i = 0; i < 6; i++) await cite({ domain: "reddit.com", prompt: `p${i}` });
    await run();
    await db.query("UPDATE project_source_index SET brand_present_on_domain=false, verified_at=now() WHERE project_id=$1", [projectId]);
    await run();
    const r = await db.query("SELECT source_coverage::float8 AS c FROM projects WHERE id=$1", [projectId]);
    expect(r.rows[0].c).toBeCloseTo(0, 3);
  });

  it("an empty project writes nothing and leaves source_coverage null", async () => {
    await run();
    expect((await rows()).length).toBe(0);
    const r = await db.query("SELECT source_coverage FROM projects WHERE id=$1", [projectId]);
    expect(r.rows[0].source_coverage).toBeNull();
  });

  it("source_coverage stays null while every domain is unverified, never 100", async () => {
    await cite({ domain: "reddit.com", prompt: "p1" });
    await run();
    const r = await db.query("SELECT source_coverage FROM projects WHERE id=$1", [projectId]);
    expect(r.rows[0].source_coverage).toBeNull();
  });
});
