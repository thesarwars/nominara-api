import "reflect-metadata";
import { randomBytes } from "node:crypto";
import { DiscoveryModule, DiscoveryService, MetadataScanner } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { Redis } from "ioredis";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiModule } from "../../src/api/api.module.js";
import { configureApp } from "../../src/api/configure-app.js";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { ACCESS_COOKIE_NAME } from "../../src/lib/auth/cookies.js";
import { SessionService } from "../../src/modules/identity/session.service.js";
import { apiUrl } from "../support/api-url.js";
import { applyFakeApiEnv } from "../support/fake-env.js";
import { startValkey, startValkeyFixture, type StartedValkey, type ValkeyFixture } from "../support/valkey-fixture.js";
import { walkRoutes } from "../support/discover-contract-routes.js";
import { getIsolationProvidedContext, getMaintenanceConnection } from "./support/context.js";
import { discoverTenantTables } from "./support/discovery.js";
import { judgeReplay, normaliseBody } from "./support/fuzz-judge.js";
import { classifyCacheKeys } from "./support/live-keys.js";
import { isRunnableForCurrentTarget } from "./support/target-guard.js";

// STORY-012 AC5 / ISO-08 AT THE HTTP BOUNDARY, and AC8's live half for the cache (ISO-13).
//
// iso-08-fuzz-replay.ts replays tenant A's identifiers at the data-access boundary, which cannot see what the ROUTES do with an identifier: a handler that
// reads by id without a scope check, or one whose status code or body differs for "exists, not yours" and "does not exist", leaks through the HTTP surface even
// with every policy correct (the story's own note: "a handler that leaks an identifier's existence through a status code difference is still an information
// leak - hence only refusals, not no data").
//
// THE REAL APPLICATION (ApiModule, every guard, interceptor and filter) is booted as `nominara_app` over a COPY of the isolation fixture database, with its own
// throwaway Valkey containers (never a developer's). Tenant B's owner replays tenant A's and C's resource identifiers against every parameterised GET route.
// Each replay is judged four ways, none of which an allow-list can soften:
//   1. never a 5xx, and never a 429 (a throttled replay proves nothing);
//   2. never a success where the same route answers a RANDOM identifier with a refusal (that is data returned for an id that is not B's);
//   3. no foreign identifier in the body, other than one the request itself named;
//   4. the answer for "exists, belongs to A" is indistinguishable from "does not exist": same status, same normalised body.
// And where B's OWN identifier makes the route answer 2xx, a foreign identifier must be exactly 403 or 404 (the specification's "only 403/404").
const REPLAYS = 500;
const SEED = 0x5eed08;
const NAMESPACE = `isofuzz-${randomBytes(4).toString("hex")}`;

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The first path segment(s) of a route to the table its `:id` names. A route with no entry still runs, on the generic pool: there is nothing to skip. */
const TABLE_BY_PREFIX: ReadonlyArray<readonly [string, string]> = [
  ["projects", "projects"],
  ["runs", "capture_runs"],
  ["results", "answer_captures"],
  ["tasks", "tasks"],
  ["tools/runs", "tool_runs"],
  ["share-tokens", "share_tokens"],
  ["workspaces", "workspaces"],
  ["themes", "brand_themes"],
  ["exports", "report_artifacts"],
  ["geo/alignment", "alignment_sessions"],
  ["integrations/gsc", "gsc_connections"],
  ["aux-audits", "aux_audits"],
  ["patches", "aux_patches"],
];

/** Routes a tenant session does not reach by identifier: provider callbacks, the portal's own session kind, public and token-addressed ones. */
const NOT_TENANT_SESSION_ROUTES = [/^auth\//u, /^portal\//u, /^public\//u, /^report-links\//u, /^integrations\/gsc\/oauth\//u, /^health/u, /^me(\/|$)/u];

interface Replayable {
  readonly path: string;
  readonly params: readonly string[];
  readonly table: string | null;
}

describe.skipIf(!isRunnableForCurrentTarget("ISO-08"))("STORY-012 AC5 · ISO-08 over HTTP: a foreign identifier gets only refusals, indistinguishable from a missing one", () => {
  const provided = getIsolationProvidedContext();
  const { a, b, c } = provided.fixture;
  const COPY_DATABASE = `nominara_iso_http_${String(Date.now())}`;
  let cacheValkey: StartedValkey;
  let queueValkey: ValkeyFixture;
  let app: NestFastifyApplication;
  let superuser: Client;
  let routes: Replayable[] = [];
  // The `reads` class is a per-user token bucket (burst 60, 300/min, api-specification §12), and a throttled replay proves nothing. The limits stay as they are:
  // the replays are spread over several of tenant B's own admins (the fixture seeds one per fourth member), each a real member with a real session.
  let bCookies: string[] = [];
  let aCookie = "";
  let turn = 0;
  const bCookie = (): string => bCookies[turn++ % bCookies.length]!;
  const originalEnv = { ...process.env };

  const pools = new Map<string, Map<string, string[]>>(); // workspace -> table -> ids

  async function harvest(workspaceId: string): Promise<Map<string, string[]>> {
    const byTable = new Map<string, string[]>();
    for (const table of await discoverTenantTables(superuser)) {
      if (!table.columns.has("id")) continue;
      const result = await superuser.query<{ id: string }>(`SELECT id::text FROM ${table.name} WHERE ${table.scopeColumn} = $1 ORDER BY id LIMIT 4`, [workspaceId]);
      if (result.rows.length > 0) byTable.set(table.name, result.rows.map((row) => row.id));
    }
    return byTable;
  }

  async function sessionCookie(userId: string, workspaceId: string, role: string = "owner"): Promise<string> {
    const sessions = app.get(SessionService);
    const tokens = await sessions.createSession(userId);
    const version = (await superuser.query<{ entitlement_version: number }>("SELECT entitlement_version FROM workspaces WHERE id = $1", [workspaceId])).rows[0]!.entitlement_version;
    const entered = await sessions.switchWorkspace(tokens.sid, userId, workspaceId, role, null, version);
    return `${ACCESS_COOKIE_NAME}=${entered.accessToken}`;
  }

  // The workspace-scoped `reads` bucket is shared by every member of a tenant (burst 60, refilling 1,200/min, api-specification §12). The limits stay as they are:
  // each request waits PACE_MS, which keeps the whole replay under the refill rate, so a 429 means a real defect rather than the suite outrunning the limiter.
  const PACE_MS = 70;
  const get = async (cookie: string, path: string) => {
    await new Promise((resolve) => setTimeout(resolve, PACE_MS));
    return app.inject({ method: "GET", url: apiUrl(path), headers: { cookie } });
  };

  /** Fills each `:param` of a route from `pick(index)`; the identifiers used are returned so a body that merely echoes one can be told from a leak. */
  function fill(route: Replayable, pick: (index: number) => string): { url: string; used: string[] } {
    const used: string[] = [];
    let index = 0;
    const url = route.path.replace(/:[A-Za-z]+/gu, () => {
      const id = pick(index++);
      used.push(id);
      return id;
    });
    return { url: `/${url}`, used };
  }

  const random = rngIds();
  function rngIds() {
    let n = 0;
    return () => `0192f1a0-0000-7000-8000-${(0xfff000000000 + n++).toString(16).padStart(12, "0")}`;
  }

  beforeAll(async () => {
    const maintenance = getMaintenanceConnection();
    const admin = new Client({ host: maintenance.host, port: maintenance.port, database: maintenance.maintenanceDatabase, ...maintenance.superuser });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${COPY_DATABASE} TEMPLATE ${provided.breakerTemplateDatabase}`);
    } finally {
      await admin.end();
    }
    superuser = new Client({ host: provided.host, port: provided.port, database: COPY_DATABASE, ...provided.superuser });
    await superuser.connect();

    [cacheValkey, queueValkey] = await Promise.all([startValkey(), startValkeyFixture()]);
    applyFakeApiEnv();
    const asApp = new URL(`postgres://${provided.host}:${String(provided.port)}/${COPY_DATABASE}`);
    asApp.username = "nominara_app";
    asApp.password = resolvePassword("nominara_app", {});
    process.env.DATABASE_URL = asApp.toString();
    process.env.DATABASE_URL_POOLED = asApp.toString();
    process.env.VALKEY_CACHE_URL = cacheValkey.url;
    // NODE_ENV=test selects the PER-PROCESS in-memory cache (cache.module.ts), which would leave the live Valkey empty and this assertion vacuous. The
    // composition root is booted as it deploys (`development` selects the Valkey adapter, against OUR throwaway container), and the namespace follows.
    process.env.NODE_ENV = "development";
    // The deployment namespace is a DISTINCTIVE literal, and the live keys are judged against that literal: judged against whatever the code resolves it to, a
    // regression to the NODE_ENV fallback ("development") would be judged by itself and pass.
    process.env.CACHE_KEY_NAMESPACE = NAMESPACE;
    process.env.QUEUE_REDIS_URL = queueValkey.connectionString;

    const moduleRef = await Test.createTestingModule({ imports: [ApiModule, DiscoveryModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await configureApp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    const walked = await walkRoutes(moduleRef.get(DiscoveryService), moduleRef.get(MetadataScanner));
    routes = walked
      .filter((route) => Reflect.getMetadata("method", route.handler) === 0 /* RequestMethod.GET */)
      .filter((route) => route.fullPath.includes(":") && !NOT_TENANT_SESSION_ROUTES.some((skip) => skip.test(route.fullPath)))
      .map((route) => ({
        path: route.fullPath,
        params: [...route.fullPath.matchAll(/:([A-Za-z]+)/gu)].map((m) => m[1]!),
        table: TABLE_BY_PREFIX.find(([prefix]) => route.fullPath === prefix || route.fullPath.startsWith(`${prefix}/`))?.[1] ?? null,
      }));

    for (const tenant of [a, b, c]) pools.set(tenant.workspaceId, await harvest(tenant.workspaceId));
    // Members 4, 8, 12, ... of the fixture carry the `admin` role (ROLE_CYCLE in three-tenant-fixture.ts).
    const adminIndexes = [4, 8, 12, 16, 20, 24, 28, 32];
    bCookies = await Promise.all(adminIndexes.map((i) => sessionCookie(b.userIds[i]!, b.workspaceId, "admin")));
    aCookie = await sessionCookie(a.userIds[4]!, a.workspaceId, "admin");
  }, 240_000);

  afterAll(async () => {
    await app?.close();
    await superuser?.end().catch(() => undefined);
    await Promise.all([cacheValkey?.stop(), queueValkey?.stop()]);
    process.env = { ...originalEnv };
    const maintenance = getMaintenanceConnection();
    const admin = new Client({ host: maintenance.host, port: maintenance.port, database: maintenance.maintenanceDatabase, ...maintenance.superuser });
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${COPY_DATABASE} WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  }, 120_000);

  /** One identifier for parameter `index` of `route`, from `workspaceId`'s pool: the route's own table first, the whole pool otherwise. */
  function idFor(route: Replayable, workspaceId: string, index: number, rand: () => number): string {
    const pool = pools.get(workspaceId)!;
    const own = route.table === null || index > 0 ? undefined : pool.get(route.table);
    const ids = own ?? [...pool.values()].flat();
    return ids[Math.floor(rand() * ids.length)]!;
  }

  it("the harness is not vacuous: parameterised GET routes were discovered, every tenant has identifiers, and the two sessions are different tenants'", () => {
    expect(routes.length).toBeGreaterThanOrEqual(20);
    for (const tenant of [a, b, c]) expect([...pools.get(tenant.workspaceId)!.values()].flat().length).toBeGreaterThan(20);
    expect(new Set([...bCookies, aCookie]).size, "every actor has its own session").toBe(bCookies.length + 1);
    expect(bCookies.length).toBeGreaterThanOrEqual(8);
  });

  it(`${String(REPLAYS)} replays of A's and C's identifiers under B's admins' sessions yield only refusals, indistinguishable from an identifier that does not exist`, async () => {
    // Baseline per route: a RANDOM identifier under B. This is what "does not exist" looks like to B, route by route. For a route with more than one parameter the
    // MIXED baseline is B's own parent with a random child: the mixed-ownership replay below must look exactly like that.
    const baseline = new Map<string, { status: number; body: string }>();
    const mixedBaseline = new Map<string, { status: number; body: string }>();
    // The control: B's OWN identifier under B. Where it answers 2xx the route demonstrably resolves ids, so a foreign one must be exactly 403/404.
    const resolves = new Set<string>();
    const rand = mulberry32(SEED);
    for (const route of routes) {
      const missing = fill(route, () => random());
      const refused = await get(bCookie(), missing.url);
      expect(refused.statusCode, `baseline ${route.path} was throttled or failed`).not.toBe(429);
      baseline.set(route.path, { status: refused.statusCode, body: normaliseBody(refused.body, missing.used) });
      const own = fill(route, (index) => idFor(route, b.workspaceId, index, rand));
      const answered = await get(bCookie(), own.url);
      expect(answered.statusCode, `control ${route.path} was throttled`).not.toBe(429);
      expect(answered.statusCode, `control ${route.path}: B's own identifier`).toBeLessThan(500);
      if (answered.statusCode >= 200 && answered.statusCode < 300) resolves.add(route.path);
      if (route.params.length > 1) {
        const parent = idFor(route, b.workspaceId, 0, rand);
        const mixed = fill(route, (index) => (index === 0 ? parent : random()));
        const response = await get(bCookie(), mixed.url);
        expect(response.statusCode, `mixed baseline ${route.path} was throttled`).not.toBe(429);
        mixedBaseline.set(route.path, { status: response.statusCode, body: normaliseBody(response.body, mixed.used) });
      }
    }
    // A control that never succeeds would let every refusal below be "the route refuses everything". These are the routes whose own-id read works.
    expect(resolves.size, `routes that answered B's own identifier with 2xx: ${[...resolves].join(", ")}`).toBeGreaterThanOrEqual(10);

    const foreignIds = new Set([...pools.get(a.workspaceId)!.values(), ...pools.get(c.workspaceId)!.values()].flat());
    const resolving = routes.filter((route) => resolves.has(route.path));
    const multi = routes.filter((route) => route.params.length > 1);
    const failures: string[] = [];
    let refused = 0;
    let onResolving = 0;
    let mixedReplays = 0;
    const resolvingCovered = new Set<string>();
    // The main replays, then a dedicated mixed-ownership pass: every multi-parameter route gets MIXED_PER_ROUTE replays of B's own parent with a foreign child,
    // so the floor below does not depend on how often the weighted draw happens to land on one of the few such routes.
    const MIXED_PER_ROUTE = 8;
    const plan: { route: Replayable; forceMixed: boolean }[] = [];
    for (let i = 0; i < REPLAYS; i++) {
      const route = rand() < 0.75 ? resolving[Math.floor(rand() * resolving.length)]! : routes[Math.floor(rand() * routes.length)]!;
      plan.push({ route, forceMixed: false });
    }
    for (const route of multi) for (let k = 0; k < MIXED_PER_ROUTE; k++) plan.push({ route, forceMixed: true });
    for (const [i, step] of plan.entries()) {
      const route = step.route;
      const victim = rand() < 0.5 ? a.workspaceId : c.workspaceId;
      // Mixed ownership on a multi-parameter route: B's OWN parent with a foreign child (a handler that scopes the parent and trusts the child).
      const mixed = multi.includes(route) && (step.forceMixed || rand() < 0.5);
      const parent = mixed ? idFor(route, b.workspaceId, 0, rand) : "";
      const { url, used } = fill(route, (index) => (mixed && index === 0 ? parent : idFor(route, victim, index, rand)));
      const response = await get(bCookie(), url);
      if (resolves.has(route.path)) {
        onResolving++;
        resolvingCovered.add(route.path);
      }
      if (mixed) mixedReplays++;
      const failuresHere = judgeReplay({
        label: `#${String(i)} GET ${url} -> ${String(response.statusCode)}${mixed ? " (mixed ownership)" : ""}`,
        status: response.statusCode,
        body: response.body,
        used,
        baseline: mixed ? mixedBaseline.get(route.path)! : baseline.get(route.path)!,
        // A mixed replay's own parent resolves; only the child is foreign, so it is held to "same as a missing child" rather than to 403/404 specifically.
        resolves: !mixed && resolves.has(route.path),
        foreignIds,
      });
      failures.push(...failuresHere);
      if (failuresHere.length === 0 && response.statusCode >= 400) refused++;
    }
    expect(failures, `seed=${String(SEED)}\n${failures.slice(0, 10).join("\n")}`).toEqual([]);
    // Floors, so a replay that "passes" because nothing ran, or everything was refused upstream of the scope check, cannot stand.
    expect(refused).toBeGreaterThanOrEqual(Math.floor(plan.length * 0.9));
    expect(onResolving, "replays on routes that resolve identifiers").toBeGreaterThanOrEqual(Math.floor(REPLAYS * 0.7));
    expect(resolvingCovered.size, "distinct resolving routes replayed").toBeGreaterThanOrEqual(Math.floor(resolving.length * 0.8));
    if (multi.length > 0) expect(mixedReplays, "mixed-ownership replays on multi-parameter routes").toBeGreaterThanOrEqual(20);
  }, 400_000);

  // ISO-13, the live half: what the traffic above actually left in the cache. Every authenticated request above touched rate-limit and session state.
  it("STORY-012 AC8 · ISO-13 live: every key in the cache the traffic wrote is namespaced {env}:{ws}:… (or the global exception), and no key names two tenants", async () => {
    // Tenant A's own admin reads its own workspace, so A has keys of its own to be judged (the replays above ran only as B).
    for (let i = 0; i < 3; i++) {
      const own = await get(aCookie, `/workspaces/${a.workspaceId}`);
      expect(own.statusCode, `A's own read: ${own.body.slice(0, 200)}`).toBe(200);
    }
    const redis = new Redis(cacheValkey.url);
    try {
      const keys: string[] = [];
      let cursor = "0";
      do {
        const [next, batch] = await redis.scan(cursor, "COUNT", 500);
        cursor = next;
        keys.push(...batch);
      } while (cursor !== "0");

      const report = classifyCacheKeys(keys, { env: NAMESPACE, tenantIds: [a.workspaceId, b.workspaceId, c.workspaceId] });
      expect(report.violations, `un-namespaced or mixed keys among ${String(keys.length)}`).toEqual([]);
      // Non-vacuity: the two tenants that made requests each have tenant keys, and neither has the other's.
      expect(report.tenantKeys.get(a.workspaceId)?.length ?? 0, `tenant A's keys among ${keys.slice(0, 12).join(" | ")}`).toBeGreaterThan(0);
      expect(report.tenantKeys.get(b.workspaceId)?.length ?? 0, "tenant B's keys").toBeGreaterThan(0);

      // The judge against THIS keyspace, made to fail: a planted un-namespaced tenant key and a planted two-tenant key are both caught.
      await redis.set(`${a.workspaceId}:planted:x`, "1");
      // The NODE_ENV fallback namespace: the key a regression of CACHE_KEY_NAMESPACE would write. It must fail against the pinned literal.
      await redis.set(`development:${a.workspaceId}:planted:y`, "1");
      await redis.set(`${NAMESPACE}:${a.workspaceId}:planted:${b.workspaceId}`, "1");
      const planted: string[] = [];
      let planting = "0";
      do {
        const [next, batch] = await redis.scan(planting, "COUNT", 500);
        planting = next;
        planted.push(...batch);
      } while (planting !== "0");
      const reasons = classifyCacheKeys(planted, { env: NAMESPACE, tenantIds: [a.workspaceId, b.workspaceId, c.workspaceId] }).violations.map((v) => v.reason).sort();
      expect(reasons).toEqual(["a tenant key with no deployment namespace", "a tenant key with no deployment namespace", "one key names two tenants"]);
    } finally {
      redis.disconnect();
    }
  });
});
