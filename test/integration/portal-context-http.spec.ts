import { randomBytes, randomUUID } from "node:crypto";
import { Controller, Get, Query } from "@nestjs/common";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PortalCookiePayload } from "../../contracts/portal/index.js";
import { PortalRoute, PortalSession, selectPortalProject, type PortalSessionContext } from "../../src/api/decorators/portal-route.decorator.js";
import { PortalContextInterceptor } from "../../src/api/interceptors/portal-context.interceptor.js";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { loadPortalCookieKey, PORTAL_COOKIE_NAME, sealPortalCookie } from "../../src/modules/portal/portal-cookie.js";
import { ShareTokensService } from "../../src/modules/agency/share-tokens.service.js";
import { AuditChainService } from "../../src/modules/audit/audit-chain.service.js";
import { currentTenantStore } from "../../src/tenancy/tenant-context.js";
import { apiUrl } from "../support/api-url.js";
import { useApiHarness } from "../support/api-harness.js";
import { startValkey, startValkeyFixture, type StartedValkey, type ValkeyFixture } from "../support/valkey-fixture.js";

// STORY-098 part B (NEW-E-098b) — the PortalContext, through the REAL ApiModule's global chain plus one test-only
// probe controller (the ThrowingController pattern). The portal pool logs in as the REAL nominara_portal role, so
// the scope assertions below are made by the database, not by the application.
const COOKIE_KEY_B64 = randomBytes(32).toString("base64url");
const KEY = loadPortalCookieKey(COOKIE_KEY_B64);

@Controller("portal-probe")
class ProbeController {
  @Get("scope/:projectId")
  @PortalRoute()
  async scope(@PortalSession() session: PortalSessionContext, @Query("project") project?: string) {
    const selected = project === undefined ? null : selectPortalProject(session, project);
    const client = currentTenantStore()!.client;
    const visible = await client.query<{ id: string }>("SELECT id FROM projects ORDER BY id");
    const ctx = await client.query<{ ws: string; scope: string; role: string; ro: string }>(
      `SELECT current_setting('app.current_workspace_id', true) AS ws, current_setting('app.current_scope_projects', true) AS scope,
              current_user AS role, current_setting('transaction_read_only') AS ro`,
    );
    let writeError: string | null = null;
    try {
      await client.query("SAVEPOINT w");
      await client.query("INSERT INTO projects (workspace_id, name, slug, root_url, root_domain) VALUES ($1,'x','x','https://x.test','x.test')", [session.workspaceId]);
    } catch (e) {
      writeError = (e as { code?: string }).code ?? "unknown";
      await client.query("ROLLBACK TO SAVEPOINT w");
    }
    return { visible: visible.rows.map((r) => r.id), selected, session, ...ctx.rows[0]!, writeError };
  }
}

describe("STORY-098 part B · PortalContext (nominara_portal pool, scope from the cookie, revocation on every request)", () => {
  let cacheValkey: StartedValkey;
  let queueValkey: ValkeyFixture;
  const harness = useApiHarness({
    env: () => {
      const u = new URL(process.env.DATABASE_URL!);
      u.username = "nominara_portal";
      u.password = resolvePassword("nominara_portal", {});
      return {
        VALKEY_CACHE_URL: cacheValkey.url,
        QUEUE_REDIS_URL: queueValkey.connectionString,
        PORTAL_COOKIE_KEY: COOKIE_KEY_B64,
        DATABASE_URL_PORTAL: u.toString(),
      };
    },
    extras: { controllers: [ProbeController], providers: [PortalContextInterceptor, ShareTokensService, AuditChainService] },
  });

  beforeAll(async () => {
    [cacheValkey, queueValkey] = await Promise.all([startValkey(), startValkeyFixture()]);
  }, 180_000);
  afterAll(async () => {
    await Promise.all([cacheValkey.stop(), queueValkey.stop()]);
  });
  beforeEach(async () => {
    await harness.db().query(`ALTER ROLE nominara_portal PASSWORD '${resolvePassword("nominara_portal", {})}'`);
  });

  let creator = "";
  const errorOf = (res: { json(): unknown }) => (res.json() as { error: { code: string } }).error;

  interface World {
    readonly wsA: string;
    readonly wsB: string;
    readonly a1: string;
    readonly a2: string;
    readonly b1: string;
  }

  async function world(): Promise<World> {
    const db = harness.db();
    const [wsA, wsB, a1, a2, b1, user] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    for (const ws of [wsA, wsB]) await db.query("INSERT INTO workspaces (id, name, slug, plan_key) VALUES ($1::uuid,$1::text,$1::text,'growth')", [ws]);
    await db.query("INSERT INTO users (id, email, email_verified_at, status) VALUES ($1,$2,now(),'active')", [user, `${user}@example.test`]);
    for (const [id, ws] of [[a1, wsA], [a2, wsA], [b1, wsB]] as const) {
      await db.query("INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain) VALUES ($1,$2,'P',$3,'https://a.test','a.test')", [id, ws, `p-${id.slice(0, 8)}`]);
    }
    creator = user;
    return { wsA, wsB, a1, a2, b1 };
  }

  async function tokenRow(workspaceId: string, scope: string[], over: { revoked?: boolean; expired?: boolean; maxViews?: number; viewCount?: number } = {}): Promise<string> {
    const id = randomUUID();
    const user = creator;
    await harness.db().query(
      `INSERT INTO share_tokens (id, workspace_id, label, token_hash, token_prefix, password_required, scope_project_ids, created_by,
                                 revoked_at, expires_at, max_views, view_count)
       VALUES ($1,$2,'t',$3,'abcdefgh',false,$4::uuid[],$5,$6,$7,$8,$9)`,
      [id, workspaceId, randomBytes(32), scope, user, over.revoked === true ? new Date() : null, over.expired === true ? new Date(Date.now() - 1000) : null, over.maxViews ?? null, over.viewCount ?? 0],
    );
    return id;
  }

  async function cookieFor(w: { tokenId: string; workspaceId: string; scope: string[]; tabs?: PortalCookiePayload["scope_tabs"] }): Promise<string> {
    const { value } = await sealPortalCookie(
      { token_id: w.tokenId, workspace_id: w.workspaceId, scope_project_ids: w.scope, scope_tabs: w.tabs ?? ["overview"], theme_id: null },
      KEY,
    );
    return `${PORTAL_COOKIE_NAME}=${value}`;
  }

  const probe = (cookie: string | null, path = "/portal-probe/scope/x", headers: Record<string, string> = {}) =>
    harness.app().inject({ method: "GET", url: apiUrl(path), headers: { ...(cookie === null ? {} : { cookie }), ...headers } });

  it("STORY-098 s9 · the transaction runs as nominara_portal, READ ONLY, with workspace and scope set from the cookie alone", async () => {
    const w = await world();
    const t = await tokenRow(w.wsA, [w.a1]);
    const res = await probe(await cookieFor({ tokenId: t, workspaceId: w.wsA, scope: [w.a1] }));
    expect(res.statusCode, res.body).toBe(200);
    const d = (res.json() as { data: { role: string; ro: string; ws: string; scope: string; visible: string[]; writeError: string | null } }).data;
    expect(d.role).toBe("nominara_portal");
    expect(d.ro).toBe("on");
    expect(d.ws).toBe(w.wsA);
    expect(d.scope).toBe(w.a1);
    expect(d.visible).toEqual([w.a1]); // a2 is in the same workspace and is invisible: the DATABASE narrowed it
    expect(["25006", "42501"]).toContain(d.writeError);
  });

  it("STORY-098 s9 · a project id in the path, the query and a header is ignored: scope and workspace stay the cookie's", async () => {
    const w = await world();
    const t = await tokenRow(w.wsA, [w.a1]);
    const cookie = await cookieFor({ tokenId: t, workspaceId: w.wsA, scope: [w.a1] });
    const res = await probe(cookie, `/portal-probe/scope/${w.a2}?scope=${w.a2}&workspace_id=${w.wsB}`, {
      "x-project-id": w.a2,
      "x-nominara-workspace": w.wsB,
      "x-portal-scope": `${w.a1},${w.a2},${w.b1}`,
    });
    expect(res.statusCode, res.body).toBe(200);
    const d = (res.json() as { data: { visible: string[]; ws: string; scope: string } }).data;
    expect(d.visible).toEqual([w.a1]);
    expect(d.ws).toBe(w.wsA);
    expect(d.scope).toBe(w.a1);
  });

  it("STORY-098 s9 · the query selector is intersected with the cookie scope: out-of-scope is a 403, in-scope is honoured, absent means the whole scope", async () => {
    const w = await world();
    const t = await tokenRow(w.wsA, [w.a1]);
    const cookie = await cookieFor({ tokenId: t, workspaceId: w.wsA, scope: [w.a1] });
    const widened = await probe(cookie, `/portal-probe/scope/x?project=${w.a2}`);
    expect(widened.statusCode).toBe(403);
    expect(errorOf(widened).code).toBe("project_out_of_scope");
    const foreign = await probe(cookie, `/portal-probe/scope/x?project=${w.b1}`);
    expect(foreign.statusCode).toBe(403);
    const own = await probe(cookie, `/portal-probe/scope/x?project=${w.a1}`);
    expect(own.statusCode).toBe(200);
    expect((own.json() as { data: { selected: string } }).data.selected).toBe(w.a1);
  });

  it("STORY-098 s9 · a cookie that claims a project the database does not scope to the workspace sees nothing of it", async () => {
    const w = await world();
    const t = await tokenRow(w.wsA, [w.a1]);
    // Even a validly SEALED payload naming b1 (another workspace) reads zero rows of it: the policy keys on workspace AND scope.
    const res = await probe(await cookieFor({ tokenId: t, workspaceId: w.wsA, scope: [w.a1, w.b1] }));
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { data: { visible: string[] } }).data.visible).toEqual([w.a1]);
  });

  it("STORY-098 s17 · a token revoked mid-session fails the very next portal request", async () => {
    const w = await world();
    const t = await tokenRow(w.wsA, [w.a1]);
    const cookie = await cookieFor({ tokenId: t, workspaceId: w.wsA, scope: [w.a1] });
    expect((await probe(cookie)).statusCode).toBe(200);
    await harness.db().query("UPDATE share_tokens SET revoked_at = now() WHERE id = $1", [t]);
    const after = await probe(cookie);
    expect(after.statusCode).toBe(401);
    expect(errorOf(after).code).toBe("token_revoked");
  });

  it("STORY-098 s16 · an expired token, a deleted token and a token over its view cap are refused on a request in flight", async () => {
    const w = await world();
    const expired = await tokenRow(w.wsA, [w.a1], { expired: true });
    const overCap = await tokenRow(w.wsA, [w.a1], { maxViews: 2, viewCount: 3 });
    const atCap = await tokenRow(w.wsA, [w.a1], { maxViews: 2, viewCount: 2 });
    const gone = await tokenRow(w.wsA, [w.a1]);
    await harness.db().query("DELETE FROM share_tokens WHERE id = $1", [gone]);
    for (const t of [expired, overCap, gone]) {
      const res = await probe(await cookieFor({ tokenId: t, workspaceId: w.wsA, scope: [w.a1] }));
      expect(res.statusCode, t).toBe(401);
    }
    // The LAST permitted view (count == cap) is a session that was legitimately minted: it keeps working.
    expect((await probe(await cookieFor({ tokenId: atCap, workspaceId: w.wsA, scope: [w.a1] }))).statusCode).toBe(200);
  });

  it("STORY-098 s17 · a validly sealed cookie whose workspace is not the token's workspace is refused", async () => {
    const w = await world();
    const t = await tokenRow(w.wsA, [w.a1]);
    const res = await probe(await cookieFor({ tokenId: t, workspaceId: w.wsB, scope: [w.b1] }));
    expect(res.statusCode).toBe(401);
  });

  it("STORY-098 s8 · no cookie, a tampered cookie, and a cookie under another key are all 401 unauthenticated and set no data", async () => {
    const w = await world();
    const t = await tokenRow(w.wsA, [w.a1]);
    const good = await cookieFor({ tokenId: t, workspaceId: w.wsA, scope: [w.a1] });
    const other = await sealPortalCookie(
      { token_id: t, workspace_id: w.wsA, scope_project_ids: [w.a1], scope_tabs: ["overview"], theme_id: null },
      loadPortalCookieKey(randomBytes(32).toString("base64url")),
    );
    for (const cookie of [null, `${PORTAL_COOKIE_NAME}=garbage`, good.slice(0, -3) + "AAA", `${PORTAL_COOKIE_NAME}=${other.value}`]) {
      const res = await probe(cookie);
      expect(res.statusCode).toBe(401);
      expect(res.body).not.toContain(w.a1);
    }
  });

  it("STORY-098 s21 · portal responses are private, non-cacheable and search-excluded — success and refusal alike", async () => {
    const w = await world();
    const t = await tokenRow(w.wsA, [w.a1]);
    const ok = await probe(await cookieFor({ tokenId: t, workspaceId: w.wsA, scope: [w.a1] }));
    const refused = await probe(null);
    for (const res of [ok, refused]) {
      expect(res.headers["cache-control"]).toBe("private, no-store");
      expect(String(res.headers["x-robots-tag"])).toContain("noindex");
    }
  });

  it("STORY-098 s9 · no tenant bleed across pooled connections: 40 concurrent requests over two tokens each see only their own scope", async () => {
    const w = await world();
    const t1 = await tokenRow(w.wsA, [w.a1]);
    const t2 = await tokenRow(w.wsA, [w.a2]);
    const c1 = await cookieFor({ tokenId: t1, workspaceId: w.wsA, scope: [w.a1] });
    const c2 = await cookieFor({ tokenId: t2, workspaceId: w.wsA, scope: [w.a2] });
    const results = await Promise.all(
      Array.from({ length: 40 }, async (_, i) => ({ i, res: await probe(i % 2 === 0 ? c1 : c2) })),
    );
    for (const { i, res } of results) {
      expect(res.statusCode).toBe(200);
      expect((res.json() as { data: { visible: string[] } }).data.visible).toEqual([i % 2 === 0 ? w.a1 : w.a2]);
    }
  });
});
