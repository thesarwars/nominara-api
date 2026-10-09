import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SessionService } from "../../src/modules/identity/session.service.js";
import { ACCESS_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER_NAME, REFRESH_COOKIE_NAME } from "../../src/lib/auth/cookies.js";
import { apiUrl } from "../support/api-url.js";
import { dataOf } from "../support/envelope.js";
import { useApiHarness } from "../support/api-harness.js";

// NEW-A-2 — GET /v1/me and PATCH /v1/me. Real Postgres, the real deployed
// ApiModule: the route sits behind AuthGuard, CSRF and the envelope, none of
// which a mocked controller would exercise.
interface MeBody {
  user: { user_id: string; name: string; email: string };
  active_workspace_id: string | null;
  persona: { org_type: string | null; volume: string | null; focus: string | null; skipped: boolean } | null;
  locale: string;
  timezone: string;
}

describe("NEW-A-2 · /v1/me", () => {
  const harness = useApiHarness();

  interface Tokens {
    readonly access: string;
    readonly refresh: string;
    readonly csrf: string;
  }

  async function createUser(fullName: string | null = "Ada Lovelace"): Promise<{ id: string; email: string }> {
    const id = randomUUID();
    const email = `${id}@example.test`;
    await harness.db().query(
      `INSERT INTO users (id, email, email_verified_at, full_name, locale, timezone, status, created_at, updated_at)
       VALUES ($1, $2, now(), $3, 'de-DE', 'Europe/Berlin', 'active', now(), now())`,
      [id, email, fullName],
    );
    return { id, email };
  }

  async function signIn(userId: string): Promise<Tokens> {
    const t = await harness.app().get(SessionService).createSession(userId);
    return { access: t.accessToken, refresh: t.refreshToken, csrf: t.csrfToken };
  }

  function get(tokens: Tokens | null, query = "") {
    return harness.app().inject({
      method: "GET",
      url: apiUrl(`/me${query}`),
      ...(tokens ? { cookies: { [ACCESS_COOKIE_NAME]: tokens.access, [CSRF_COOKIE_NAME]: tokens.csrf } } : {}),
    });
  }

  function patch(tokens: Tokens, payload: unknown, withCsrf = true) {
    return harness.app().inject({
      method: "PATCH",
      url: apiUrl("/me"),
      cookies: { [ACCESS_COOKIE_NAME]: tokens.access, [CSRF_COOKIE_NAME]: tokens.csrf },
      ...(withCsrf ? { headers: { [CSRF_HEADER_NAME]: tokens.csrf } } : {}),
      payload: payload as object,
    });
  }

  const persona = { org_type: "agency", volume: "6_20", focus: "technical_seo", skipped: false } as const;

  it("NEW-A-2 · GET /me returns the caller's identity, locale, timezone, a null workspace and a null persona", async () => {
    const user = await createUser();
    const res = await get(await signIn(user.id));
    expect(res.statusCode, res.body).toBe(200);
    expect(dataOf<MeBody>(res)).toEqual({
      user: { user_id: user.id, name: "Ada Lovelace", email: user.email },
      active_workspace_id: null,
      persona: null,
      locale: "de-DE",
      timezone: "Europe/Berlin",
    });
  });

  it("NEW-A-2 · GET /me without a session is 401", async () => {
    const res = await get(null);
    expect(res.statusCode).toBe(401);
  });

  it("NEW-A-2 · a user with no full_name gets the local part of the address, never an empty or null name", async () => {
    const user = await createUser(null);
    const res = await get(await signIn(user.id));
    expect(dataOf<MeBody>(res).user.name).toBe(user.email.split("@")[0]);
  });

  it("NEW-A-2 · PATCH /me persists the persona and echoes it, and GET /me then reads it back", async () => {
    const user = await createUser();
    const tokens = await signIn(user.id);
    const res = await patch(tokens, { persona });
    expect(res.statusCode, res.body).toBe(200);
    expect(dataOf<MeBody>(res).persona).toEqual(persona);
    expect(dataOf<MeBody>(await get(tokens)).persona).toEqual(persona);
    const row = await harness
      .db()
      .query(`SELECT persona_org_type, persona_volume_band, persona_focus, persona_skipped FROM users WHERE id = $1`, [user.id]);
    expect(row.rows[0]).toEqual({
      persona_org_type: "agency",
      persona_volume_band: "6_20",
      persona_focus: "technical_seo",
      persona_skipped: false,
    });
  });

  it("NEW-A-2 · a skipped persona is stored as skipped, distinct from never answered (null)", async () => {
    const user = await createUser();
    const tokens = await signIn(user.id);
    const skipped = { org_type: null, volume: null, focus: null, skipped: true };
    const res = await patch(tokens, { persona: skipped });
    expect(res.statusCode, res.body).toBe(200);
    expect(dataOf<MeBody>(await get(tokens)).persona).toEqual(skipped);
  });

  it("NEW-A-2 · PATCH replaces the whole persona (a second PATCH clears fields it sets to null)", async () => {
    const user = await createUser();
    const tokens = await signIn(user.id);
    await patch(tokens, { persona });
    const partial = { org_type: "in_house", volume: null, focus: null, skipped: false };
    await patch(tokens, { persona: partial });
    expect(dataOf<MeBody>(await get(tokens)).persona).toEqual(partial);
  });

  it("NEW-A-2 · a row still carrying the retired lt_1k volume reads as no volume, not as a value the client cannot render", async () => {
    const user = await createUser();
    await harness.db().query(`UPDATE users SET persona_org_type = 'agency', persona_volume_band = 'lt_1k' WHERE id = $1`, [user.id]);
    const me = dataOf<MeBody>(await get(await signIn(user.id)));
    expect(me.persona).toEqual({ org_type: "agency", volume: null, focus: null, skipped: false });
  });

  it("NEW-A-2 · PATCH with an unknown top-level field is 400", async () => {
    const tokens = await signIn((await createUser()).id);
    const res = await patch(tokens, { persona, email: "someone@else.test" });
    expect(res.statusCode).toBe(400);
  });

  it("NEW-A-2 · PATCH with an unknown persona field is 400", async () => {
    const tokens = await signIn((await createUser()).id);
    const res = await patch(tokens, { persona: { ...persona, plan: "enterprise" } });
    expect(res.statusCode).toBe(400);
  });

  it("NEW-A-2 · PATCH rejects a volume outside the brand-count vocabulary (the retired lt_1k band) with 400", async () => {
    const tokens = await signIn((await createUser()).id);
    const res = await patch(tokens, { persona: { ...persona, volume: "lt_1k" } });
    expect(res.statusCode).toBe(400);
  });

  it("NEW-A-2 · PATCH with an empty body is 400", async () => {
    const tokens = await signIn((await createUser()).id);
    expect((await patch(tokens, {})).statusCode).toBe(400);
  });

  it("NEW-A-2 · PATCH without the CSRF header is refused and writes nothing", async () => {
    const user = await createUser();
    const res = await patch(await signIn(user.id), { persona }, false);
    expect(res.statusCode).toBe(403);
    const row = await harness.db().query(`SELECT persona_org_type FROM users WHERE id = $1`, [user.id]);
    expect(row.rows[0].persona_org_type).toBeNull();
  });

  it("NEW-A-2 · GET /me never returns another user's data, and PATCH never writes another user's row", async () => {
    const a = await createUser("Alice");
    const b = await createUser("Bob");
    const aTokens = await signIn(a.id);
    const bTokens = await signIn(b.id);
    await patch(aTokens, { persona });

    const bMe = dataOf<MeBody>(await get(bTokens, `?user_id=${a.id}`));
    expect(bMe.user.user_id).toBe(b.id);
    expect(bMe.user.name).toBe("Bob");
    expect(bMe.persona).toBeNull();

    // A body naming another user is an unknown key.
    expect((await patch(bTokens, { persona, user_id: a.id })).statusCode).toBe(400);
  });

  it("NEW-A-2 · active_workspace_id is the token's ws claim, never a query or body value", async () => {
    const user = await createUser();
    const tokens = await signIn(user.id);
    const created = await harness.app().inject({
      method: "POST",
      url: apiUrl("/workspaces"),
      cookies: { [ACCESS_COOKIE_NAME]: tokens.access, [CSRF_COOKIE_NAME]: tokens.csrf },
      headers: { [CSRF_HEADER_NAME]: tokens.csrf },
      payload: { name: `Workspace ${randomUUID()}` },
    });
    expect(created.statusCode, created.body).toBe(201);
    const workspaceId = dataOf<{ id: string }>(created).id;

    // Before the switch the claim is null; a query naming a workspace changes nothing.
    const before = dataOf<MeBody>(await get(tokens, `?workspace_id=${workspaceId}&active_workspace_id=${workspaceId}`));
    expect(before.active_workspace_id).toBeNull();

    const switched = await harness.app().inject({
      method: "POST",
      url: apiUrl(`/workspaces/${workspaceId}/switch`),
      cookies: { [ACCESS_COOKIE_NAME]: tokens.access, [REFRESH_COOKIE_NAME]: tokens.refresh, [CSRF_COOKIE_NAME]: tokens.csrf },
      headers: { [CSRF_HEADER_NAME]: tokens.csrf },
    });
    expect(switched.statusCode, switched.body).toBe(200);
    const byName = new Map(switched.cookies.map((c) => [c.name, c.value]));
    const after: Tokens = { access: byName.get(ACCESS_COOKIE_NAME)!, refresh: byName.get(REFRESH_COOKIE_NAME)!, csrf: byName.get(CSRF_COOKIE_NAME)! };

    const other = randomUUID();
    const me = dataOf<MeBody>(await get(after, `?workspace_id=${other}`));
    expect(me.active_workspace_id).toBe(workspaceId);
  });

  // NEW-B-1 checkpoint-4 — a live session must not outlive the user's standing. Suspended is 403 (the account exists and is
  // forbidden; STORY-173 AC5 already pins 403 for a suspended account), erased/missing is 401.
  it("NEW-B-1 · a suspended user with a live session is refused on GET /me and nothing is returned", async () => {
    const user = await createUser();
    const tokens = await signIn(user.id);
    expect((await get(tokens)).statusCode).toBe(200);
    await harness.db().query(`UPDATE users SET status = 'suspended' WHERE id = $1`, [user.id]);
    const res = await get(tokens);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.body).not.toContain(user.email);
  });

  it("NEW-B-1 · a suspended user with a live session is refused on PATCH /me and the row is not written", async () => {
    const user = await createUser();
    const tokens = await signIn(user.id);
    await harness.db().query(`UPDATE users SET status = 'suspended' WHERE id = $1`, [user.id]);
    const res = await patch(tokens, { persona });
    expect(res.statusCode, res.body).toBe(403);
    const row = await harness.db().query(`SELECT persona_org_type FROM users WHERE id = $1`, [user.id]);
    expect(row.rows[0].persona_org_type).toBeNull();
  });

  it("NEW-B-1 · a suspended user is refused on another authenticated route (GET /workspaces), not only /me", async () => {
    const user = await createUser();
    const tokens = await signIn(user.id);
    await harness.db().query(`UPDATE users SET status = 'suspended' WHERE id = $1`, [user.id]);
    const res = await harness.app().inject({
      method: "GET",
      url: apiUrl("/workspaces"),
      cookies: { [ACCESS_COOKIE_NAME]: tokens.access, [CSRF_COOKIE_NAME]: tokens.csrf },
    });
    expect(res.statusCode, res.body).toBe(403);
  });

  it("NEW-B-1 · an erased user (deleted_at set) with a live session is refused on GET and PATCH /me", async () => {
    const user = await createUser();
    const tokens = await signIn(user.id);
    await harness.db().query(`UPDATE users SET deleted_at = now() WHERE id = $1`, [user.id]);
    expect((await get(tokens)).statusCode).toBe(401);
    expect((await patch(tokens, { persona })).statusCode).toBe(401);
  });

  it("NEW-B-1 · reinstating a suspended user (status back to active) restores access on the same session", async () => {
    const user = await createUser();
    const tokens = await signIn(user.id);
    await harness.db().query(`UPDATE users SET status = 'suspended' WHERE id = $1`, [user.id]);
    expect((await get(tokens)).statusCode).toBe(403);
    await harness.db().query(`UPDATE users SET status = 'active' WHERE id = $1`, [user.id]);
    expect((await get(tokens)).statusCode).toBe(200);
  });
});
