import { createHash, randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { playbookResponseSchema, sourceIndexResponseSchema } from "../../contracts/analytics/index.js";
import { refreshProjectSourceIndex } from "../../src/lib/rollup/refresh-project-source-index.js";
import { SourcesService } from "../../src/modules/analytics/sources.service.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";

// NEW-C-7 — the sources read and the playbook gate, over NEW-C-4's index.

const promptUuid = (name: string): string => {
  const h = createHash("sha256").update(name).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

describe("NEW-C-7 · sources read and playbook", () => {
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

  async function newProject(): Promise<{ ws: string; pr: string }> {
    const ws = randomUUID();
    const pr = randomUUID();
    await db.query("INSERT INTO workspaces (id,name,slug,plan_key,timezone) VALUES ($1,'W',$2,'growth','UTC')", [ws, `w-${ws.slice(0, 8)}`]);
    await db.query(
      `INSERT INTO projects (id,workspace_id,name,slug,root_url,root_domain) VALUES ($1,$2,'Acme',$3,'https://acme.com','acme.com')`,
      [pr, ws, `p-${pr.slice(0, 8)}`],
    );
    return { ws, pr };
  }

  beforeEach(async () => {
    await db.query("TRUNCATE citation_facts, project_source_index, source_domains, competitors, projects, workspaces CASCADE");
    ({ ws: workspaceId, pr: projectId } = await newProject());
  });

  async function cite(o: { domain: string; prompt: string; url?: string; competitor?: boolean; sourceClass?: string; daysAgo?: number; ws?: string; pr?: string }): Promise<void> {
    const url = o.url ?? `https://${o.domain}/p/${randomUUID().slice(0, 6)}`;
    await db.query(
      `INSERT INTO citation_facts
         (workspace_id, project_id, result_id, prompt_id, engine_key, captured_at, slot_index, raw_url, normalized_url,
          url_hash, domain, is_owned, is_competitor, source_class, http_status, position_weight)
       VALUES ($1,$2,$3,$4,'gemini', now() - ($5::int * interval '1 day'), 1,$6,$6,$7,$8,false,$9,$10,200,1)`,
      [o.ws ?? workspaceId, o.pr ?? projectId, randomUUID(), promptUuid(o.prompt), o.daysAgo ?? 1, url, createHash("sha256").update(url).digest(), o.domain, o.competitor ?? false, o.sourceClass ?? null],
    );
  }

  const refresh = async (pr = projectId): Promise<void> => {
    await db.query("BEGIN");
    await refreshProjectSourceIndex(db, pr);
    await db.query("COMMIT");
  };
  const verify = (domain: string, present: boolean): Promise<unknown> =>
    db.query(
      `UPDATE project_source_index SET brand_present_on_domain=$2, verified_at=now(),
              gap_severity = CASE WHEN $2 THEN 'none' ELSE 'critical' END
        WHERE source_domain_id IN (SELECT id FROM source_domains WHERE domain=$1)`,
      [domain, present],
    );
  const asTenant = <T>(fn: () => Promise<T>, ws = workspaceId): Promise<T> =>
    withTenantContext(db, { workspaceId: ws, actorId: randomUUID() }, fn) as Promise<T>;
  const index = (timeframe: "7d" | "30d" | "90d" = "30d", pr = projectId, ws = workspaceId) =>
    asTenant(() => new SourcesService().sourceIndex(pr, { timeframe }), ws);
  const playbook = (domain: string, timeframe: "7d" | "30d" | "90d" = "30d") =>
    asTenant(() => new SourcesService().playbook(projectId, domain, { timeframe }));

  it("NEW-C-7 AC1 · returns the contract shape, ordered by influence, normalised to sum 1", async () => {
    for (let i = 0; i < 5; i++) await cite({ domain: "reddit.com", prompt: `p${i}` });
    await cite({ domain: "g2.com", prompt: "p0" });
    await refresh();
    const res = await index();
    sourceIndexResponseSchema.parse(res);
    expect(res.domains.map((d) => d.domain)).toEqual(["reddit.com", "g2.com"]);
    expect(res.domains[0]!.influence).toBeGreaterThan(res.domains[1]!.influence);
    expect(res.domains.reduce((s, d) => s + d.influence, 0)).toBeCloseTo(1, 5);
    expect(res.domains[0]!.source_class).toBe("community_forum");
    expect(res.domains[0]!.seedable).toBe(true);
    expect(res.domains[0]!.top_urls[0]).toMatchObject({ citations: 1 });
    expect(res.window.to >= res.window.from).toBe(true);
  });

  it("NEW-C-7 AC1 · unverified presence is null, never false; verified absent is false", async () => {
    await cite({ domain: "reddit.com", prompt: "p1" });
    await cite({ domain: "g2.com", prompt: "p1" });
    await refresh();
    await verify("g2.com", false);
    const byDomain = Object.fromEntries((await index()).domains.map((d) => [d.domain, d]));
    expect(byDomain["reddit.com"]).toMatchObject({ brand_present: null, verified_at: null, gap_severity: null });
    expect(byDomain["g2.com"]!.brand_present).toBe(false);
    expect(byDomain["g2.com"]!.verified_at).not.toBeNull();
    expect(byDomain["g2.com"]!.gap_severity).toBe("critical");
  });

  it("NEW-C-7 AC1 · timeframe selects the window; a citation 20 days old is absent from 7d, present in 30d", async () => {
    await cite({ domain: "old.example", prompt: "p1", daysAgo: 20 });
    await refresh();
    expect((await index("7d")).domains).toHaveLength(0);
    expect((await index("30d")).domains.map((d) => d.domain)).toEqual(["old.example"]);
  });

  it("NEW-C-7 · lists the competitor whose own domain it is; empty source_coverage stays a number-or-null", async () => {
    await db.query(
      `INSERT INTO competitors (id,workspace_id,project_id,name,root_domain,aliases,source) VALUES ($1,$2,$3,'Rival','rival.com',ARRAY[]::text[],'user')`,
      [randomUUID(), workspaceId, projectId],
    );
    // community_forum is a seedable class: only the competitor flag can make it non-seedable.
    await cite({ domain: "rival.com", prompt: "p1", competitor: true, sourceClass: "community_forum" });
    await refresh();
    const res = await index();
    expect(res.domains[0]!.competitors_present).toEqual(["Rival"]);
    expect(res.domains[0]!.seedable).toBe(false);
    expect(res.domains[0]!.source_class).toBe("vendor_owned");
    expect(res.source_coverage === null || typeof res.source_coverage === "number").toBe(true);
  });

  it("NEW-C-7 · empty index returns an empty list, not an error", async () => {
    const res = await index();
    expect(res.domains).toEqual([]);
  });

  it("NEW-C-7 · another workspace's context cannot read this project's index (RLS)", async () => {
    await cite({ domain: "reddit.com", prompt: "p1" });
    await refresh();
    const other = await newProject();
    // The container user is a superuser and bypasses RLS; read as the app role.
    await db.query("SET ROLE nominara_app");
    try {
      await expect(index("30d", projectId, other.ws)).rejects.toMatchObject({ code: "not_found" });
      expect((await index("30d", projectId, workspaceId)).domains).toHaveLength(1);
    } finally {
      await db.query("RESET ROLE");
    }
  });

  it("NEW-C-7 · unknown project is 404", async () => {
    await expect(asTenant(() => new SourcesService().sourceIndex(randomUUID(), { timeframe: "30d" }))).rejects.toMatchObject({ code: "not_found" });
  });

  it("STORY-055 #1/#2 · a critical gap on a seedable domain gets the class playbook with every required part", async () => {
    await cite({ domain: "reddit.com", prompt: "p1", url: "https://reddit.com/r/x/1" });
    await refresh();
    await verify("reddit.com", false);
    const pb = await playbook("reddit.com");
    playbookResponseSchema.parse(pb);
    expect(pb.template_slug).toBe("playbook-community_forum");
    expect(pb.target_url).toBe("https://reddit.com/r/x/1");
    expect(pb.why.length).toBeGreaterThan(0);
    expect(pb.outline.length).toBeGreaterThan(0);
    expect(pb.disclosure.toLowerCase()).toContain("affiliation");
    expect(pb.do_not.length).toBeGreaterThanOrEqual(3);
    expect(pb.verification.length).toBeGreaterThan(0);
  });

  it("NEW-C-7 AC3 · rules[] is empty with a stated reason — platform rules are never invented", async () => {
    await cite({ domain: "reddit.com", prompt: "p1" });
    await refresh();
    await verify("reddit.com", false);
    const pb = await playbook("reddit.com");
    expect(pb.rules).toEqual([]);
    expect(pb.rules_unavailable_reason).toEqual(expect.any(String));
  });

  it("STORY-055 #3 / FR-SR-03a · no playbook (409) for a non-seedable domain", async () => {
    // Seedable class + verified absent + critical severity: only the competitor-owned
    // read (is_seedable AND NOT is_competitor_owned) can refuse this playbook.
    await cite({ domain: "rival.com", prompt: "p1", competitor: true, sourceClass: "community_forum" });
    await refresh();
    await verify("rival.com", false);
    const row = (await index()).domains.find((d) => d.domain === "rival.com")!;
    expect(row).toMatchObject({ seedable: false, source_class: "vendor_owned", brand_present: false });
    await expect(playbook("rival.com")).rejects.toMatchObject({ code: "conflict" });
  });

  it("STORY-055 #3 / FR-SR-03a · the same forum, not competitor-owned, DOES get a playbook (the 409 above is the competitor flag)", async () => {
    await cite({ domain: "rival.com", prompt: "p1", sourceClass: "community_forum" });
    await refresh();
    await verify("rival.com", false);
    expect((await index()).domains[0]).toMatchObject({ seedable: true, source_class: "community_forum" });
    await expect(playbook("rival.com")).resolves.toMatchObject({ template_slug: "playbook-community_forum" });
  });

  it("FR-SR-03a · the playbook gate checks seedability itself: a templated class on a domain flagged non-seedable is refused even at critical", async () => {
    await cite({ domain: "reddit.com", prompt: "p1" });
    await refresh();
    await verify("reddit.com", false);
    await db.query("UPDATE source_domains SET is_seedable=false WHERE domain='reddit.com'");
    expect((await index()).domains[0]).toMatchObject({ source_class: "community_forum", seedable: false, gap_severity: "critical" });
    await expect(playbook("reddit.com")).rejects.toMatchObject({ code: "conflict" });
  });

  it("FR-SR-03a · 409 when the gap is not critical/high (brand present), and when presence is unverified", async () => {
    await cite({ domain: "reddit.com", prompt: "p1" });
    await cite({ domain: "g2.com", prompt: "p1" });
    await refresh();
    await verify("g2.com", true);
    await expect(playbook("g2.com")).rejects.toMatchObject({ code: "conflict" });
    await expect(playbook("reddit.com")).rejects.toMatchObject({ code: "conflict" });
  });

  it("NEW-C-7 · a domain not in this project's index is 404", async () => {
    await expect(playbook("nowhere.example")).rejects.toMatchObject({ code: "not_found" });
  });
});
