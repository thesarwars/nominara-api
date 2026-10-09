import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionService } from "../../src/modules/identity/session.service.js";
import {
  ACCESS_COOKIE_NAME,
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  REFRESH_COOKIE_NAME,
} from "../../src/lib/auth/cookies.js";
import { importEd25519PublicKeyFromDer, verifyAccessToken } from "../../src/lib/auth/access-token.js";
import { apiUrl } from "../support/api-url.js";
import { dataOf } from "../support/envelope.js";
import { HARNESS_PUBLIC_KEY_DER, useApiHarness } from "../support/api-harness.js";

// A plan change (Stripe webhook -> applyPlan) bumps workspaces.entitlement_version, so every
// live session carries a stale `ent_v`. The wire contract is the CLOSED taxonomy of
// api-conventions §2: 401 `unauthenticated` with `details.reason = "entitlement_stale"` (decision
// D12 maps the guard's out-of-taxonomy code there). The client keys its silent refresh on that
// reason, so this spec pins the exact shape AND that POST /auth/refresh recovers from it.
describe("entitlement_stale on the wire, and recovery by refresh", () => {
  const harness = useApiHarness();
  let pool: Pool;

  beforeEach(() => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
  });
  afterEach(async () => {
    await pool.end();
  });

  interface Tokens {
    readonly access: string;
    readonly refresh: string;
    readonly csrf: string;
  }

  function tokensOf(res: { cookies: Array<{ name: string; value: string }> }): Tokens {
    const byName = new Map(res.cookies.map((c) => [c.name, c.value]));
    return { access: byName.get(ACCESS_COOKIE_NAME)!, refresh: byName.get(REFRESH_COOKIE_NAME)!, csrf: byName.get(CSRF_COOKIE_NAME)! };
  }

  async function entV(token: string): Promise<number | null> {
    const key = importEd25519PublicKeyFromDer(HARNESS_PUBLIC_KEY_DER);
    return (await verifyAccessToken(token, () => key)).ent_v;
  }

  async function listProjects(t: Tokens) {
    return harness.app().inject({
      method: "GET",
      url: apiUrl("/projects"),
      cookies: { [ACCESS_COOKIE_NAME]: t.access, [CSRF_COOKIE_NAME]: t.csrf },
    });
  }

  it("a session whose ent_v is behind gets 401 unauthenticated / details.reason entitlement_stale; refresh mints the new ent_v and the retry succeeds", async () => {
    const userId = randomUUID();
    await harness.db().query(
      `INSERT INTO users (id, email, email_verified_at, status, created_at, updated_at)
       VALUES ($1, $2, now(), 'active', now(), now())`,
      [userId, `${userId}@example.test`],
    );
    const sessions = harness.app().get(SessionService);
    const initial = await sessions.createSession(userId);
    const signedIn: Tokens = { access: initial.accessToken, refresh: initial.refreshToken, csrf: initial.csrfToken };

    const created = await harness.app().inject({
      method: "POST",
      url: apiUrl("/workspaces"),
      cookies: { [ACCESS_COOKIE_NAME]: signedIn.access, [CSRF_COOKIE_NAME]: signedIn.csrf },
      headers: { [CSRF_HEADER_NAME]: signedIn.csrf },
      payload: { name: `Workspace ${randomUUID()}` },
    });
    expect(created.statusCode, created.body).toBe(201);
    const workspaceId = dataOf<{ id: string }>(created).id;

    const switched = await harness.app().inject({
      method: "POST",
      url: apiUrl(`/workspaces/${workspaceId}/switch`),
      cookies: { [ACCESS_COOKIE_NAME]: signedIn.access, [REFRESH_COOKIE_NAME]: signedIn.refresh, [CSRF_COOKIE_NAME]: signedIn.csrf },
      headers: { [CSRF_HEADER_NAME]: signedIn.csrf },
    });
    expect(switched.statusCode, switched.body).toBe(200);
    const session = tokensOf(switched);
    const before = await entV(session.access);
    expect(before).not.toBeNull();
    expect((await listProjects(session)).statusCode).toBe(200);

    // What the plan-set worker / Stripe reconcile does.
    await pool.query("UPDATE workspaces SET entitlement_version = entitlement_version + 1 WHERE id = $1", [workspaceId]);

    const stale = await listProjects(session);
    expect(stale.statusCode, stale.body).toBe(401);
    expect(stale.headers["content-type"]).toContain("application/problem+json");
    const problem = (stale.json() as { error: { code: string; details: { reason: string } } }).error;
    expect(problem.code).toBe("unauthenticated");
    expect(problem.details.reason).toBe("entitlement_stale");

    const refreshed = await harness.app().inject({
      method: "POST",
      url: apiUrl("/auth/refresh"),
      cookies: { [REFRESH_COOKIE_NAME]: session.refresh },
    });
    expect(refreshed.statusCode, refreshed.body).toBe(200);
    const next = tokensOf(refreshed);
    expect(await entV(next.access)).toBe(before! + 1);

    const retried = await listProjects(next);
    expect(retried.statusCode, retried.body).toBe(200);
  });
});
