import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { ACCESS_COOKIE_NAME, CSRF_COOKIE_NAME } from "../../src/lib/auth/cookies.js";
import { InMemoryCacheAdapter } from "../../src/lib/cache/in-memory-cache.adapter.js";
import { NoopRealtimePublisher } from "../../src/lib/cache/realtime-publisher.js";
import { AuditChainService } from "../../src/modules/audit/audit-chain.service.js";
import { SessionService } from "../../src/modules/identity/session.service.js";
import { LocalDekProvisioner } from "../../src/modules/workspaces/adapters/local-dek-provisioner.js";
import { MembershipService } from "../../src/modules/workspaces/membership.service.js";
import { WorkspacesService } from "../../src/modules/workspaces/workspaces.service.js";
import { MembershipCacheService } from "../../src/tenancy/membership-cache.js";
import { useApiHarness } from "../support/api-harness.js";
import { apiUrl } from "../support/api-url.js";
import { dataOf } from "../support/envelope.js";
import { testCacheRedisUrl } from "../support/test-valkey.js";

// STORY-090 AC8/AC9 - the custom range on the two reads the Overview filters, through the real ApiModule as `nominara_app`. Starter's rollup window is 395 days.
const meta = { ip: "127.0.0.1", ua: "vitest", requestId: randomUUID() };
const day = (offset: number): string => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

describe("STORY-090 AC9 · custom range on scorecards and the growth map", () => {
  const harness = useApiHarness({
    env: () => {
      const url = new URL(process.env.DATABASE_URL!);
      url.username = "nominara_app";
      url.password = resolvePassword("nominara_app", {});
      return { DATABASE_URL_POOLED: url.toString(), VALKEY_CACHE_URL: testCacheRedisUrl() };
    },
  });
  let pool: Pool;
  let sessions: SessionService;
  let workspaces: WorkspacesService;

  beforeEach(async () => {
    await harness.db().query(`ALTER ROLE nominara_app PASSWORD '${resolvePassword("nominara_app", {})}'`);
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const membership = new MembershipService(new MembershipCacheService());
    sessions = new SessionService(pool, membership, new InMemoryCacheAdapter());
    workspaces = new WorkspacesService(pool, new LocalDekProvisioner(Buffer.alloc(32, 7), "local:dev"), new AuditChainService(), membership, sessions, new NoopRealtimePublisher());
  });
  afterEach(async () => {
    await pool.end();
  });

  async function setup(plan: string): Promise<{ cookies: Record<string, string>; projectId: string }> {
    const ownerId = (await harness.db().query<{ id: string }>("INSERT INTO users (email) VALUES ($1) RETURNING id", [`o-${randomUUID()}@example.com`])).rows[0]!.id;
    const ws = await workspaces.create(ownerId, { name: `W ${randomUUID()}` }, meta);
    await harness.db().query("UPDATE workspaces SET plan_key = $2 WHERE id = $1", [ws.id, plan]);
    const tokens = await sessions.createSession(ownerId);
    const entered = await workspaces.switchTo(ownerId, tokens.sid, ws.id, meta);
    const projectId = randomUUID();
    await harness.db().query("INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain) VALUES ($1,$2,'P',$3,'https://e.test','e.test')", [projectId, ws.id, `p-${projectId.slice(0, 8)}`]);
    return { cookies: { [ACCESS_COOKIE_NAME]: entered.accessToken, [CSRF_COOKIE_NAME]: entered.csrfToken }, projectId };
  }
  const read = (a: { cookies: Record<string, string>; projectId: string }, route: string, query: string) =>
    harness.app().inject({ method: "GET", url: apiUrl(`/projects/${a.projectId}/${route}?${query}`), cookies: a.cookies });
  const issues = (res: { json(): unknown }) => ((res.json() as { error: { details: { issues: { path: string[]; message: string }[] } } }).error.details.issues);

  it("scorecards: a range inside retention is served for exactly the days asked, and says it is custom", async () => {
    const a = await setup("starter");
    const res = await read(a, "scorecards", `timeframe=custom&from=${day(-40)}&to=${day(-10)}`);
    expect(res.statusCode, res.body).toBe(200);
    const body = dataOf<{ timeframe: string; window: { from: string; to: string } }>(res);
    expect(body.timeframe).toBe("custom");
    expect(body.window).toMatchObject({ from: day(-40), to: day(-10) });
  });

  it("scorecards: a range starting before the plan's retention is a 400 naming the earliest day, never trimmed", async () => {
    const a = await setup("starter");
    const res = await read(a, "scorecards", `timeframe=custom&from=${day(-396)}&to=${day(-390)}`);
    expect(res.statusCode).toBe(400);
    expect(issues(res)[0]).toMatchObject({ path: ["from"] });
    expect(issues(res)[0]!.message).toContain(day(-395));
    // The boundary day itself is served.
    expect((await read(a, "scorecards", `timeframe=custom&from=${day(-395)}&to=${day(-390)}`)).statusCode).toBe(200);
  });

  it("scorecards: a future `to` is a 400, and a preset timeframe carrying a range is a 400 (not silently ignored)", async () => {
    const a = await setup("starter");
    const future = await read(a, "scorecards", `timeframe=custom&from=${day(-5)}&to=${day(2)}`);
    expect(future.statusCode).toBe(400);
    expect(issues(future)[0]).toMatchObject({ path: ["to"] });
    expect((await read(a, "scorecards", `timeframe=30d&from=${day(-5)}&to=${day(-1)}`)).statusCode).toBe(400);
  });

  it("growth map: a custom range plots the days asked, by the day up to 90 and by the week beyond", async () => {
    const a = await setup("starter");
    const short = await read(a, "growth-map", `timeframe=custom&from=${day(-29)}&to=${day(-1)}`);
    expect(short.statusCode, short.body).toBe(200);
    expect(dataOf<{ granularity: string; timeframe: { from: string; to: string } }>(short)).toMatchObject({ granularity: "day", timeframe: { from: day(-29), to: day(-1) } });
    const long = await read(a, "growth-map", `timeframe=custom&from=${day(-200)}&to=${day(-1)}`);
    expect(long.statusCode, long.body).toBe(200);
    expect(dataOf<{ granularity: string }>(long).granularity).toBe("week");
    expect((await read(a, "growth-map", `timeframe=custom&from=${day(-200)}&to=${day(-1)}&granularity=day`)).statusCode).toBe(400);
  });

  it("growth map: beyond retention is a 400 with the boundary; a plan with no rollup window (Free) has no lower bound but the one-year cap holds", async () => {
    const starter = await setup("starter");
    const beyond = await read(starter, "growth-map", `timeframe=custom&from=${day(-400)}&to=${day(-380)}`);
    expect(beyond.statusCode).toBe(400);
    expect(issues(beyond)[0]!.message).toContain(day(-395));
    const free = await setup("free");
    expect((await read(free, "growth-map", `timeframe=custom&from=${day(-700)}&to=${day(-600)}`)).statusCode).toBe(200);
    const tooLong = await read(free, "growth-map", `timeframe=custom&from=${day(-700)}&to=${day(-300)}`);
    expect(tooLong.statusCode).toBe(400);
    expect(issues(tooLong)[0]).toMatchObject({ path: ["to"] });
  });
});
