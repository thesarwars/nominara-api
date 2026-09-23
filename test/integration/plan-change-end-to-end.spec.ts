import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyPlanChange, planKeyOnly } from "../../src/lib/billing/apply-plan.js";
import { ACCESS_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "../../src/lib/auth/cookies.js";
import { SessionService } from "../../src/modules/identity/session.service.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import { uuidV7 } from "../../src/lib/ids/uuidv7.js";
import { useApiHarness } from "../support/api-harness.js";

// STORY-151 — THE TEST THE WHOLE STORY EXISTS FOR.
//
// ⚠ IT ASSERTS THE PRODUCT IS UNREACHABLE BEFORE IT ASSERTS THE FIX. Step 3
// below proves `POST /v1/projects` is REFUSED for a workspace created by
// production code — and that refusal is not a bug in this test, it is the
// state of the product as merged. `WorkspacesService.create` writes `plan_key`
// as the literal 'free' (:232), nothing in `src/` has ever written any other
// value, free's `projects.max` is 0, and `wouldExceed` is `current >= limit`
// (classification.ts:147), so `0 >= 0` refuses the FIRST project every
// customer ever tries to create.
//
// ⚠ AND NO SPEC IN THIS FILE MAY HAND-WRITE `plan_key`. At least ten existing
// integration specs open with `INSERT INTO workspaces (…, plan_key) VALUES
// (…, 'growth')`, bypassing the only production writer — which is exactly why
// ~330 spec files validated a tier no code path could produce and none of them
// noticed the product could not be entered. The workspace here comes from
// `POST /v1/workspaces` through the real booted ApiModule, guards and all.
describe("STORY-151 · a workspace can change plan, and that is what makes the product reachable", () => {
  const harness = useApiHarness();
  let pool: Pool;
  let sessions: SessionService;

  beforeEach(() => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    sessions = new SessionService(pool);
  });

  afterEach(async () => {
    await pool.end();
  });

  /** A real user row — the only thing here that does not go through a route. */
  async function createUser(): Promise<string> {
    const userId = uuidV7();
    await harness.db().query(
      `INSERT INTO users (id, email, email_verified_at, status, created_at, updated_at)
       VALUES ($1, $2, now(), 'active', now(), now())`,
      [userId, `${userId}@example.test`],
    );
    return userId;
  }

  function cookieHeader(access: string, csrf: string): string {
    return `${ACCESS_COOKIE_NAME}=${access}; ${CSRF_COOKIE_NAME}=${csrf}`;
  }

  it("⚠ a free workspace is REFUSED its first project; after a plan change the same request succeeds", async () => {
    const userId = await createUser();
    const tokens = await sessions.createSession(userId);

    // 1. The workspace, through the real route. plan_key comes from
    //    production code, not from this test.
    const created = await harness.app().inject({
      method: "POST",
      url: "/v1/workspaces",
      headers: {
        cookie: cookieHeader(tokens.accessToken, tokens.csrfToken),
        [CSRF_HEADER_NAME]: tokens.csrfToken,
        "content-type": "application/json",
      },
      payload: { name: "Acme", org_type: "in_house", region: "us-east-1", timezone: "UTC" },
    });
    expect(created.statusCode, created.body).toBe(201);
    const workspaceId = (created.json() as { data: { id: string } }).data.id;

    const planRow = await harness.db().query<{ plan_key: string }>(
      "SELECT plan_key FROM workspaces WHERE id = $1",
      [workspaceId],
    );
    expect(planRow.rows[0]!.plan_key, "production creates every workspace on free").toBe("free");

    // 2. Enter it — the only mint that puts `ws` and `ent_v` on a token.
    const entered = await sessions.switchWorkspace(tokens.sid, userId, workspaceId, "owner", null, 1);

    // 3. ⚠ THE PRODUCT, AS MERGED. Asserted before the fix, so this test can
    //    never quietly become a test of nothing.
    const refused = await harness.app().inject({
      method: "POST",
      url: "/v1/projects",
      headers: {
        cookie: cookieHeader(entered.accessToken, entered.csrfToken),
        [CSRF_HEADER_NAME]: entered.csrfToken,
        "content-type": "application/json",
        "idempotency-key": uuidV7(),
      },
      payload: { root_url: "https://acme.test" },
    });
    expect(refused.statusCode, `free must be refused its first project, got: ${refused.body}`).toBe(403);
    expect(refused.body).toContain("entitlement_exceeded");

    // 4. The plan change, on the same database, through the same tenant
    //    context and the same role a request would use.
    const client = await pool.connect();
    let outcome;
    try {
      outcome = await withTenantContext(client, { workspaceId, actorId: SYSTEM_ACTOR_ID }, (tx) =>
        applyPlanChange(tx, workspaceId, planKeyOnly("growth"), {
          requestId: "TICKET-1",
          operator: "test-operator",
          reason: "story-151 end to end",
        }),
      );
    } finally {
      client.release();
    }
    expect(outcome.changed).toBe(true);
    expect(outcome.to).toBe("growth");
    expect(outcome.entitlementVersion).toBe(2);

    // 5. ⚠ THE OLD TOKEN IS DEAD. This is the acceptance criterion of the
    //    version bump: security-and-tenancy.md:273 — "a mismatch forces a
    //    token refresh so a downgraded entitlement cannot be exercised with a
    //    stale token". If this passes with 202, the bump is decorative.
    const stale = await harness.app().inject({
      method: "POST",
      url: "/v1/projects",
      headers: {
        cookie: cookieHeader(entered.accessToken, entered.csrfToken),
        [CSRF_HEADER_NAME]: entered.csrfToken,
        "content-type": "application/json",
        "idempotency-key": uuidV7(),
      },
      payload: { root_url: "https://acme-two.test" },
    });
    expect(stale.statusCode, "a token minted before the change must not survive it").toBe(401);
    expect(stale.body).toContain("entitlement_stale");

    // 6. Re-enter — the recovery a client performs on `entitlement_stale`.
    const reentered = await sessions.switchWorkspace(tokens.sid, userId, workspaceId, "owner", null, 2);

    // 7. ⚠ THE ACCEPTANCE CRITERION OF THE WHOLE STORY. The identical request
    //    that was refused at step 3 now succeeds.
    const allowed = await harness.app().inject({
      method: "POST",
      url: "/v1/projects",
      headers: {
        cookie: cookieHeader(reentered.accessToken, reentered.csrfToken),
        [CSRF_HEADER_NAME]: reentered.csrfToken,
        "content-type": "application/json",
        "idempotency-key": uuidV7(),
      },
      payload: { root_url: "https://acme-three.test" },
    });
    // ⚠ WHAT THIS ASSERTS, AND WHY IT IS NOT 202. The identical request that
    // was refused at step 3 by `EntitlementGuard` now gets PAST it and is
    // refused instead by the URL guard (STORY-131), which does a real DNS
    // lookup and correctly declines a domain that does not exist. That is a
    // precise, deterministic transition — 403 `entitlement_exceeded` →
    // 422 `unsafe_target` — and it can only be reached by passing the plan
    // gate. Reaching an actual 202 would mean a real resolvable domain and a
    // real network call inside a container test, which trades a deterministic
    // assertion for a flaky one and proves nothing more about THIS story.
    //
    // ⚠ Worth recording while it is in front of us: no integration spec in
    // this repo has ever created a project over HTTP — every one of them
    // INSERTs into `projects` directly — so `POST /v1/projects` had no
    // end-to-end coverage before this line. That belongs to EPIC-06.
    expect(allowed.statusCode, `the plan gate must be open now: ${allowed.body}`).not.toBe(403);
    expect(allowed.body, "must not still be an entitlement refusal").not.toContain("entitlement_exceeded");
    expect(allowed.statusCode, `expected the URL guard, not the plan guard: ${allowed.body}`).toBe(422);
    expect(allowed.body).toContain("unsafe_target");
  }, 120_000);
});
