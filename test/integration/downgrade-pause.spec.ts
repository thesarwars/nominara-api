import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CSRF_HEADER_NAME } from "../../src/lib/auth/cookies.js";
import { reconcileDowngradePause } from "../../src/lib/billing/downgrade-pause.js";
import { CONFIRMED_CREDITS_HEADER } from "../../src/lib/credits/confirmed-credits.js";
import { UrlGuard } from "../../src/lib/net/url-guard.service.js";
import { LoggingEmailSenderAdapter } from "../../src/modules/identity/adapters/logging-email-sender.adapter.js";
import type { EmailMessage } from "../../src/modules/identity/ports/email-sender.js";
import { dataOf } from "../support/envelope.js";
import { apiUrl } from "../support/api-url.js";
import { usePlanChangeFixture, type Actor, type PlanName } from "../support/plan-change-fixture.js";
import { planChangePreviewResponseSchema } from "../../contracts/billing/index.js";
import { projectListResponseSchema } from "../../contracts/projects/index.js";
import { promptListResponseSchema } from "../../contracts/prompts/index.js";

// STORY-077 slice A — plans-and-entitlements.md §14 end to end, on the real ApiModule, a real Postgres with RLS in force
// and the fake Stripe gateway. The cut-over is what production sees: the signature-verified webhook adopting the
// target plan. Test scenarios 1–5 of the story, plus the hazards around them:
//   * a downgrade that is still REFUSED for projects or prompts (STORY-184's temporary 409);
//   * the cut-over deleting, or pausing the oldest instead of the newest;
//   * a person's pause being taken over, or resumed by an upgrade;
//   * an upgrade that leaves the customer paused (the loop §14's "resume automatically" closes);
//   * a redelivered webhook pausing, resuming or emailing twice;
//   * purchased credits clawed back.

describe("STORY-077 · downgrade: accepted, paused at the cut-over, resumed on upgrade", () => {
  const f = usePlanChangeFixture();
  const { gateway, harness } = f;
  const PREVIEW = "/billing/subscription/change/preview";
  const CHANGE = "/billing/subscription/change";

  const db = () => harness.db();

  /** `n` prompts in `projectId`, the i-th created `n - i` minutes ago (index n-1 is the newest). */
  async function prompts(workspaceId: string, projectId: string, n: number, status: "active" | "paused" = "active"): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const text = `prompt ${String(i)} ${randomUUID()}`;
      const r = await db().query<{ id: string }>(
        `INSERT INTO tracked_prompts (workspace_id, project_id, text, text_hash, intent_archetype, funnel_stage, status, created_at)
         VALUES ($1, $2, $3, sha256(convert_to($3, 'UTF8')), 'recommendation', 'consideration', $4, now() - ($5 || ' minutes')::interval) RETURNING id`,
        [workspaceId, projectId, text, status, String(n - i)],
      );
      ids.push(r.rows[0]!.id);
    }
    return ids;
  }

  const projectRows = async (workspaceId: string) =>
    (await db().query<{ id: string; status: string; paused_by_downgrade_at: Date | null; paused_by_downgrade_from: string | null; deleted_at: Date | null }>(
      "SELECT id, status, paused_by_downgrade_at, paused_by_downgrade_from, deleted_at FROM projects WHERE workspace_id = $1 ORDER BY created_at, id",
      [workspaceId],
    )).rows;
  const promptRows = async (projectId: string) =>
    (await db().query<{ id: string; status: string; paused_by_downgrade_at: Date | null; deleted_at: Date | null }>(
      "SELECT id, status, paused_by_downgrade_at, deleted_at FROM tracked_prompts WHERE project_id = $1 ORDER BY created_at, id",
      [projectId],
    )).rows;
  const markedProjects = async (workspaceId: string) => (await projectRows(workspaceId)).filter((p) => p.paused_by_downgrade_at !== null).map((p) => p.id);

  /** Schedules a downgrade through the route, then delivers Stripe's cut-over (phase 1 starts) through the webhook. */
  async function downgradeAtCutOver(workspaceId: string, owner: Actor, target: PlanName) {
    const res = await f.post(owner, CHANGE, { plan_key: target });
    expect(res.statusCode, res.body).toBe(202);
    const call = gateway.downgrades.at(-1)!;
    // The cut-over has JUST happened: the new period began a minute ago. (Its start must not be in the future, or a later
    // in-app upgrade's quote, dated now, would be refused as older than the period.)
    const start = f.nowSeconds() - 60;
    f.stripeSubscription(workspaceId, { plan: target, metadata: { plan_change_intent_id: String(call.metadata.plan_change_intent_id) }, periodStart: start, periodEnd: start + 30 * 86_400 });
    const delivered = await f.reconcile(workspaceId);
    expect(delivered.statusCode, delivered.body).toBe(200);
    expect((await f.planOf(workspaceId)).plan_key).toBe(target);
  }

  /** An in-app upgrade, charged and then adopted by the webhook. A fresh token: the version bump revoked the old one. */
  async function upgradeTo(workspaceId: string, target: PlanName) {
    const owner = await f.enter(await f.ownerOf(workspaceId), workspaceId);
    const preview = planChangePreviewResponseSchema.parse(dataOf(await f.post(owner, PREVIEW, { plan_key: target })));
    const res = await f.post(owner, CHANGE, { plan_key: target, quote: preview.quote });
    expect(res.statusCode, res.body).toBe(202);
    expect((await f.reconcile(workspaceId)).statusCode).toBe(200);
    expect((await f.planOf(workspaceId)).plan_key).toBe(target);
  }

  function spyEmail(): EmailMessage[] {
    const sent: EmailMessage[] = [];
    // On the adapter's prototype: the app holds more than one EMAIL_SENDER instance (IdentityModule's, which BillingModule
    // imports, and ReportsModule's own binding), so a spy on whichever instance app.get() returns can miss the one used.
    vi.spyOn(LoggingEmailSenderAdapter.prototype, "send").mockImplementation(async (message: EmailMessage) => {
      sent.push(message);
    });
    return sent;
  }
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---- scenario 1 -----------------------------------------------------------------------------------------------

  it("scenario 1 · a downgrade with projects and prompts above the target is ACCEPTED, effective at period end, and the confirmation names the excess as paused at period end", async () => {
    const { workspaceId, owner } = await f.newWorkspace("business");
    const ids = await f.projects(workspaceId, 5);
    await prompts(workspaceId, ids[0]!, 45); // business allows 50 per project, growth 40
    const preview = planChangePreviewResponseSchema.parse(dataOf(await f.post(owner, PREVIEW, { plan_key: "growth" })));
    expect(preview).toMatchObject({ effective: "period_end", blocked_by: null });
    expect(preview.exceeds.filter((e) => e.kind === "structural")).toEqual([
      { kind: "structural", key: "projects.max", limit: 3, current: 5, excess: 2, effect: "paused_at_period_end", paused: 2, items: [{ id: ids[4], name: "P4", prompts: 0 }, { id: ids[3], name: "P3", prompts: 0 }] },
      { kind: "structural", key: "prompts.max_per_project", project_id: ids[0], limit: 40, current: 45, excess: 5, effect: "paused_at_period_end", paused: 5 },
    ]);

    const res = await f.post(owner, CHANGE, { plan_key: "growth" });
    expect(res.statusCode, res.body).toBe(202);
    expect(dataOf(res)).toMatchObject({ status: "pending", direction: "downgrade", effective: "period_end" });
    expect(gateway.downgrades).toHaveLength(1);
    // Nothing is paused before the cut-over: the customer keeps everything for the period they paid for.
    expect(await markedProjects(workspaceId)).toEqual([]);
    expect((await projectRows(workspaceId)).every((p) => p.status === "active")).toBe(true);
  });

  // ---- scenario 3 -----------------------------------------------------------------------------------------------

  it("scenario 3 · at the cut-over the MOST RECENT excess projects and prompts are paused, never deleted, their data kept, and the list is emailed", async () => {
    const { workspaceId, owner } = await f.newWorkspace("business");
    const ids = await f.projects(workspaceId, 5);
    const big = await prompts(workspaceId, ids[0]!, 45);
    const sent = spyEmail();

    await downgradeAtCutOver(workspaceId, owner, "growth");

    const rows = await projectRows(workspaceId);
    expect(rows.map((p) => [p.id, p.status, p.paused_by_downgrade_from, p.deleted_at])).toEqual([
      [ids[0], "active", null, null],
      [ids[1], "active", null, null],
      [ids[2], "active", null, null],
      [ids[3], "paused", "active", null],
      [ids[4], "paused", "active", null],
    ]);
    expect(rows.filter((p) => p.paused_by_downgrade_at !== null).map((p) => p.id)).toEqual([ids[3], ids[4]]);

    const promptState = await promptRows(ids[0]!);
    expect(promptState).toHaveLength(45);
    expect(promptState.every((p) => p.deleted_at === null), "never deleted").toBe(true);
    expect(promptState.filter((p) => p.paused_by_downgrade_at !== null).map((p) => p.id), "the five newest").toEqual(big.slice(40));
    expect(promptState.filter((p) => p.status === "active").map((p) => p.id)).toEqual(big.slice(0, 40));

    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toMatch(/@example\.com$/);
    expect(sent[0]!.textBody).toContain("P3");
    expect(sent[0]!.textBody).toContain("P4");
    expect(sent[0]!.textBody).not.toContain("P0");
    expect(sent[0]!.textBody).toMatch(/\b5 prompts?\b/);

    const audit = await f.auditActions(workspaceId, "billing.downgrade.paused");
    expect(audit).toHaveLength(1);
    // Names, newest first, not ids: the audit redactor stores any UUID in a state as "[redacted]" (lib/crypto/redact.ts).
    expect(audit[0]!.after_state).toEqual({ project_count: 2, project_names: ["P4", "P3"], prompt_count: 5 });
  });

  it("scenario 3 · a project a PERSON paused is not taken over by the cut-over, and a redelivered cut-over pauses, audits and emails nothing more", async () => {
    const { workspaceId, owner } = await f.newWorkspace("business");
    const ids = await f.projects(workspaceId, 5);
    await db().query("UPDATE projects SET status = 'paused' WHERE id = $1", [ids[4]]);
    const sent = spyEmail();

    await downgradeAtCutOver(workspaceId, owner, "growth");
    // The person's pause stays the person's and uses NO slot (owner decision 2026-10-23, replacing review round 1's "holds
    // its slot"): four tracking projects against 3, so only the newest tracking project is paused.
    expect(await markedProjects(workspaceId)).toEqual([ids[3]]);
    expect((await projectRows(workspaceId)).find((p) => p.id === ids[4])).toMatchObject({ status: "paused", paused_by_downgrade_at: null });

    expect((await f.reconcile(workspaceId)).statusCode).toBe(200);
    expect(await markedProjects(workspaceId)).toEqual([ids[3]]);
    expect(await f.auditActions(workspaceId, "billing.downgrade.paused")).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });

  it("scenario 3 · a project still onboarding (initializing) in the excess is paused, and resumed to initializing — never straight into the scheduler", async () => {
    const { workspaceId, owner } = await f.newWorkspace("business");
    const ids = await f.projects(workspaceId, 4);
    await db().query("UPDATE projects SET status = 'initializing' WHERE id = $1", [ids[3]]);
    spyEmail();
    await downgradeAtCutOver(workspaceId, owner, "growth");
    expect((await projectRows(workspaceId)).find((p) => p.id === ids[3])).toMatchObject({ status: "paused", paused_by_downgrade_from: "initializing" });

    await upgradeTo(workspaceId, "business");
    expect((await projectRows(workspaceId)).find((p) => p.id === ids[3])).toMatchObject({ status: "initializing", paused_by_downgrade_at: null, paused_by_downgrade_from: null });
  });

  // ---- scenario 4 -----------------------------------------------------------------------------------------------

  it("scenario 4 · purchased credits are not clawed back by a downgrade that pauses", async () => {
    const { workspaceId, owner } = await f.newWorkspace("business");
    await f.walletFor(workspaceId, 1_000);
    await db().query("UPDATE credit_wallets SET purchased_balance = 777 WHERE workspace_id = $1", [workspaceId]);
    await f.projects(workspaceId, 5);
    spyEmail();
    await downgradeAtCutOver(workspaceId, owner, "growth");
    expect((await db().query<{ purchased_balance: number }>("SELECT purchased_balance FROM credit_wallets WHERE workspace_id = $1", [workspaceId])).rows[0]!.purchased_balance).toBe(777);
  });

  // ---- scenario 5 -----------------------------------------------------------------------------------------------

  it("scenario 5 · an upgrade after a downgrade pause resumes the paused projects and prompts automatically; a person's pause stays", async () => {
    const { workspaceId, owner } = await f.newWorkspace("business");
    const ids = await f.projects(workspaceId, 5);
    const big = await prompts(workspaceId, ids[0]!, 45);
    const mine = (await prompts(workspaceId, ids[1]!, 1, "paused"))[0]!;
    spyEmail();
    await downgradeAtCutOver(workspaceId, owner, "growth");
    expect(await markedProjects(workspaceId)).toHaveLength(2);

    await upgradeTo(workspaceId, "business");
    const rows = await projectRows(workspaceId);
    expect(rows.every((p) => p.status === "active" && p.paused_by_downgrade_at === null && p.paused_by_downgrade_from === null)).toBe(true);
    const promptState = await promptRows(ids[0]!);
    expect(promptState.every((p) => p.status === "active" && p.paused_by_downgrade_at === null)).toBe(true);
    expect(promptState.map((p) => p.id)).toEqual(big);
    expect((await promptRows(ids[1]!)).find((p) => p.id === mine), "a person's pause is never resumed by billing").toMatchObject({ status: "paused", paused_by_downgrade_at: null });
    expect(await f.auditActions(workspaceId, "billing.downgrade.resumed")).toHaveLength(1);
  });

  it("scenario 5 · a PARTIAL upgrade resumes the oldest paused projects first, up to the new limit", async () => {
    const { workspaceId, owner } = await f.newWorkspace("business");
    const ids = await f.projects(workspaceId, 5);
    spyEmail();
    await downgradeAtCutOver(workspaceId, owner, "starter"); // starter allows 1
    expect(await markedProjects(workspaceId)).toEqual(ids.slice(1));

    await upgradeTo(workspaceId, "growth"); // growth allows 3
    expect(await markedProjects(workspaceId)).toEqual([ids[3], ids[4]]);
    expect((await projectRows(workspaceId)).filter((p) => p.status === "active").map((p) => p.id)).toEqual(ids.slice(0, 3));
  });

  it("cancel to Free (the subscription ends) pauses every project, keeping them all, and a new subscription resumes them", async () => {
    const { workspaceId } = await f.newWorkspace("starter");
    const ids = await f.projects(workspaceId, 1);
    spyEmail();
    f.stripeSubscription(workspaceId, { plan: "starter", status: "canceled" });
    expect((await f.deliver(f.eventBody(`evt_${randomUUID()}`, "customer.subscription.deleted", f.subIdOf(workspaceId)))).statusCode).toBe(200);
    expect((await f.planOf(workspaceId)).plan_key).toBe("free");
    expect(await projectRows(workspaceId)).toEqual([expect.objectContaining({ id: ids[0], status: "paused", paused_by_downgrade_from: "active", deleted_at: null })]);

    f.stripeSubscription(workspaceId, { plan: "starter" });
    expect((await f.deliver(f.eventBody(`evt_${randomUUID()}`, "customer.subscription.created", f.subIdOf(workspaceId)))).statusCode).toBe(200);
    expect((await f.planOf(workspaceId)).plan_key).toBe("starter");
    expect(await projectRows(workspaceId)).toEqual([expect.objectContaining({ id: ids[0], status: "active", paused_by_downgrade_at: null })]);
  });

  // ---- AC5: distinguishable --------------------------------------------------------------------------------------

  it("AC5 · the project list and the prompt list say which pauses are the downgrade's", async () => {
    const { workspaceId, owner } = await f.newWorkspace("business");
    const ids = await f.projects(workspaceId, 4);
    await prompts(workspaceId, ids[0]!, 42);
    spyEmail();
    await downgradeAtCutOver(workspaceId, owner, "growth");
    const actor = await f.enter(await f.ownerOf(workspaceId), workspaceId);

    const list = projectListResponseSchema.parse(dataOf(await f.get(actor, "/projects")));
    const byId = new Map(list.map((p) => [p.id, p]));
    expect(byId.get(ids[3]!)).toMatchObject({ status: "paused" });
    expect(byId.get(ids[3]!)!.paused_by_downgrade_at).not.toBeNull();
    expect(byId.get(ids[0]!)!.paused_by_downgrade_at).toBeNull();

    const listed = promptListResponseSchema.parse(dataOf(await f.get(actor, `/projects/${ids[0]!}/prompts?limit=100`)));
    const marked = listed.prompts.filter((p) => p.paused_by_downgrade_at !== null);
    expect(marked).toHaveLength(2);
    expect(marked.every((p) => p.status === "paused")).toBe(true);
  });

  /** Operator overrides (absolute, the final word in resolution), with the version bump that invalidates the memo. */
  async function overrideEntitlements(workspaceId: string, overrides: Record<string, number>): Promise<void> {
    await db().query("UPDATE workspaces SET entitlement_overrides = $2::jsonb, entitlement_version = entitlement_version + 1 WHERE id = $1", [workspaceId, JSON.stringify(overrides)]);
  }
  const activeCount = async (projectId: string) => (await promptRows(projectId)).filter((p) => p.status === "active").length;

  /** PATCH /prompts/{id} as `actor`. */
  const patchPrompt = (actor: Actor, promptId: string, payload: Record<string, unknown>) =>
    harness.app().inject({
      method: "PATCH",
      url: apiUrl(`/prompts/${promptId}`),
      cookies: f.cookies(actor),
      headers: { [CSRF_HEADER_NAME]: actor.csrfToken, "content-type": "application/json", "idempotency-key": randomUUID() },
      payload,
    });

  /** `count` prompts in `projectId` created `fromMinutesAgo`, `fromMinutesAgo - 1`, … minutes ago (oldest first). */
  async function promptsAt(workspaceId: string, projectId: string, count: number, fromMinutesAgo: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const text = `prompt ${String(i)} ${randomUUID()}`;
      const r = await db().query<{ id: string }>(
        `INSERT INTO tracked_prompts (workspace_id, project_id, text, text_hash, intent_archetype, funnel_stage, status, created_at)
         VALUES ($1, $2, $3, sha256(convert_to($3, 'UTF8')), 'recommendation', 'consideration', 'active', now() - ($4 || ' minutes')::interval) RETURNING id`,
        [workspaceId, projectId, text, String(fromMinutesAgo - i)],
      );
      ids.push(r.rows[0]!.id);
    }
    return ids;
  }

  // ⚠ THE HAZARD (review round 1, blocker): a downgrade now leaves a workspace holding MORE prompts than its cap, the
  // excess paused. PATCH treated paused -> active as free (a paused prompt already occupies its slot), so one PATCH per
  // prompt undid the cut-over and the workspace tracked above its plan. Resuming must fit the ACTIVE count under the
  // resolved limits, on both doors, per project and workspace-wide.

  it("AC5 · resuming a downgrade-paused prompt over the cap is REFUSED (403 entitlement_exceeded); after an archive frees room it resumes and becomes the person's", async () => {
    const { workspaceId, owner } = await f.newWorkspace("business");
    const ids = await f.projects(workspaceId, 1);
    const ps = await prompts(workspaceId, ids[0]!, 41); // growth allows 40 per project
    spyEmail();
    await downgradeAtCutOver(workspaceId, owner, "growth");
    const newest = ps[40]!;
    expect((await promptRows(ids[0]!)).find((p) => p.id === newest)).toMatchObject({ status: "paused" });

    const actor = await f.enter(await f.ownerOf(workspaceId), workspaceId);
    const refused = await patchPrompt(actor, newest, { status: "active" });
    expect(refused.statusCode, refused.body).toBe(403);
    expect(JSON.parse(refused.body)).toMatchObject({ error: { code: "entitlement_exceeded", details: { key: "prompts.max_per_project", limit: 40, current: 40 } } });
    expect((await promptRows(ids[0]!)).find((p) => p.id === newest), "still the downgrade's").toMatchObject({ status: "paused" });
    expect((await promptRows(ids[0]!)).find((p) => p.id === newest)!.paused_by_downgrade_at).not.toBeNull();

    // The email's advice: archive one you no longer need, then resume the one you want.
    expect((await patchPrompt(actor, ps[0]!, { status: "archived" })).statusCode).toBe(200);
    const res = await patchPrompt(actor, newest, { status: "active" });
    expect(res.statusCode, res.body).toBe(200);
    expect((await promptRows(ids[0]!)).find((p) => p.id === newest)).toMatchObject({ status: "active", paused_by_downgrade_at: null });
    expect((await promptRows(ids[0]!)).filter((p) => p.status === "active")).toHaveLength(40);
  });

  it("AC5 · POST .../prompts/activate applies the SAME rule: refused over the cap, allowed once an archive frees room", async () => {
    const { workspaceId, owner } = await f.newWorkspace("business");
    const ids = await f.projects(workspaceId, 1);
    const ps = await prompts(workspaceId, ids[0]!, 41);
    spyEmail();
    await downgradeAtCutOver(workspaceId, owner, "growth");
    const newest = ps[40]!;

    const actor = await f.enter(await f.ownerOf(workspaceId), workspaceId);
    const refused = await f.post(actor, `/projects/${ids[0]!}/prompts/activate`, { prompt_ids: [newest] });
    expect(refused.statusCode, refused.body).toBe(403);
    expect(JSON.parse(refused.body)).toMatchObject({ error: { code: "entitlement_exceeded", details: { key: "prompts.max_per_project", limit: 40 } } });

    expect((await patchPrompt(actor, ps[0]!, { status: "archived" })).statusCode).toBe(200);
    const res = await f.post(actor, `/projects/${ids[0]!}/prompts/activate`, { prompt_ids: [newest] });
    expect(res.statusCode, res.body).toBe(200);
    expect((await promptRows(ids[0]!)).find((p) => p.id === newest)).toMatchObject({ status: "active", paused_by_downgrade_at: null });
  });

  it("AC5 · the WORKSPACE-WIDE cap (prompts.max_total) also binds a resume, on both doors, even when the project has room", async () => {
    const { workspaceId } = await f.newWorkspace("business");
    // growth: 40 per project, 120 in total. An operator override allows 4 projects, so the workspace-wide cap is the ONLY
    // one that binds here (review round 2: with growth's own 3, P3 would be in the project excess and the cut-over now
    // pauses its prompts with it, so the max_total excess would never reach P0 - the shape this test needs).
    await overrideEntitlements(workspaceId, { "projects.max": 4 });
    // The override bumps entitlement_version, so a session minted before it is stale (401 entitlement_stale): enter after.
    const owner = await f.enter(await f.ownerOf(workspaceId), workspaceId);
    const ids = await f.projects(workspaceId, 4);
    // P0's last five are the NEWEST prompts in the workspace, so the max_total excess (125 - 120) lands in P0, an
    // ACTIVE project with room under its own 40.
    const p0 = [...(await promptsAt(workspaceId, ids[0]!, 35, 2000)), ...(await promptsAt(workspaceId, ids[0]!, 5, 5))];
    await promptsAt(workspaceId, ids[1]!, 40, 1500);
    await promptsAt(workspaceId, ids[2]!, 40, 1400);
    await promptsAt(workspaceId, ids[3]!, 5, 1300);
    spyEmail();
    await downgradeAtCutOver(workspaceId, owner, "growth");
    const paused = (await promptRows(ids[0]!)).filter((p) => p.paused_by_downgrade_at !== null).map((p) => p.id);
    expect(paused).toEqual(p0.slice(35));

    const actor = await f.enter(await f.ownerOf(workspaceId), workspaceId);
    const viaPatch = await patchPrompt(actor, paused[0]!, { status: "active" });
    expect(viaPatch.statusCode, viaPatch.body).toBe(403);
    expect(JSON.parse(viaPatch.body)).toMatchObject({ error: { code: "entitlement_exceeded", details: { key: "prompts.max_total", limit: 120, current: 120 } } });
    const viaActivate = await f.post(actor, `/projects/${ids[0]!}/prompts/activate`, { prompt_ids: [paused[0]!] });
    expect(viaActivate.statusCode, viaActivate.body).toBe(403);
    expect(JSON.parse(viaActivate.body)).toMatchObject({ error: { code: "entitlement_exceeded", details: { key: "prompts.max_total", limit: 120 } } });

    expect((await patchPrompt(actor, p0[0]!, { status: "archived" })).statusCode).toBe(200);
    expect((await patchPrompt(actor, paused[0]!, { status: "active" })).statusCode).toBe(200);
  });

  it("AC5 · a person's OWN pause cannot be resumed past the cap either (an over-limit workspace binds every resume, not only the downgrade's)", async () => {
    const { workspaceId, owner } = await f.newWorkspace("business");
    const ids = await f.projects(workspaceId, 1);
    await prompts(workspaceId, ids[0]!, 40);
    const mine = (await prompts(workspaceId, ids[0]!, 1, "paused"))[0]!; // the newest, paused by a person: 41 occupy
    spyEmail();
    await downgradeAtCutOver(workspaceId, owner, "growth");
    expect((await promptRows(ids[0]!)).find((p) => p.id === mine)).toMatchObject({ status: "paused", paused_by_downgrade_at: null });

    const actor = await f.enter(await f.ownerOf(workspaceId), workspaceId);
    const refused = await patchPrompt(actor, mine, { status: "active" });
    expect(refused.statusCode, refused.body).toBe(403);
  });

  // ---- review round 2 ------------------------------------------------------------------------------------------------
  // The hazards: the customer left tracking FEWER prompts than the plan allows (the per-project and workspace excesses
  // unioned; a paused project's prompts holding the active room of the projects the customer kept); a reconcile that
  // lowers nothing re-pausing a person's resume; two concurrent resumes both fitting the workspace cap.

  it("review round 2 · per-project and workspace excess together (seed values, Business -> Growth): A=50, B=40, C=40 with B the newest leaves 40/40/40 = all 120 tracked", async () => {
    const { workspaceId, owner } = await f.newWorkspace("business");
    const [a, b, c] = await f.projects(workspaceId, 3);
    await promptsAt(workspaceId, a!, 50, 3000);
    await promptsAt(workspaceId, c!, 40, 2000);
    const bIds = await promptsAt(workspaceId, b!, 40, 1000);
    spyEmail();
    await downgradeAtCutOver(workspaceId, owner, "growth");
    expect([await activeCount(a!), await activeCount(b!), await activeCount(c!)]).toEqual([40, 40, 40]);
    expect((await promptRows(b!)).filter((p) => p.status === "active").map((p) => p.id)).toEqual(bIds);
  });

  it("review round 2 · a project the cut-over pauses takes its prompts with it (Growth -> Starter): the KEPT project, with prompts newer than the paused one's, still tracks all 30 Starter allows; an upgrade brings both back", async () => {
    const { workspaceId, owner } = await f.newWorkspace("growth");
    const [a, b] = await f.projects(workspaceId, 2);
    const aOld = await promptsAt(workspaceId, a!, 20, 3000);
    const bIds = await promptsAt(workspaceId, b!, 20, 2000);
    const aNew = await promptsAt(workspaceId, a!, 10, 100);
    spyEmail();
    await downgradeAtCutOver(workspaceId, owner, "starter");

    expect(await markedProjects(workspaceId)).toEqual([b]);
    expect((await promptRows(a!)).filter((p) => p.status === "active").map((p) => p.id)).toEqual([...aOld, ...aNew]);
    const bState = await promptRows(b!);
    expect(bState.every((p) => p.status === "paused" && p.paused_by_downgrade_at !== null), "nothing in the paused project holds the active room").toBe(true);

    // The kept project's own person-paused prompt is not blocked by B's untracked prompts: there is no room because A is
    // at 30, not because B holds it. Archive one and the resume fits.
    const actor = await f.enter(await f.ownerOf(workspaceId), workspaceId);
    expect((await patchPrompt(actor, aOld[0]!, { status: "paused" })).statusCode).toBe(200);
    expect((await patchPrompt(actor, aOld[0]!, { status: "active" })).statusCode, "A has room for its own 30").toBe(200);

    await upgradeTo(workspaceId, "growth");
    expect(await markedProjects(workspaceId)).toEqual([]);
    expect((await promptRows(b!)).filter((p) => p.status === "active").map((p) => p.id)).toEqual(bIds);
  });

  it("review round 2 · a person's resume is theirs: the cut-over leaves the plan's full 40 tracked, and a later reconcile that lowers no limit (a seat add-on) never re-pauses what the person resumed", async () => {
    const { workspaceId, owner } = await f.newWorkspace("business");
    const [p] = await f.projects(workspaceId, 1);
    const mine = await promptsAt(workspaceId, p!, 1, 5000);
    await db().query("UPDATE tracked_prompts SET status = 'paused' WHERE id = $1", [mine[0]]);
    const ps = await promptsAt(workspaceId, p!, 41, 3000);
    spyEmail();
    await downgradeAtCutOver(workspaceId, owner, "growth");
    expect(await activeCount(p!), "40 allowed, 41 active before: one paused, not two").toBe(40);
    const newest = ps[40]!;
    expect((await promptRows(p!)).filter((r) => r.paused_by_downgrade_at !== null).map((r) => r.id)).toEqual([newest]);

    // The person swaps: pauses an old one, resumes the newest (its marker cleared - now theirs).
    const actor = await f.enter(await f.ownerOf(workspaceId), workspaceId);
    expect((await patchPrompt(actor, ps[0]!, { status: "paused" })).statusCode).toBe(200);
    expect((await patchPrompt(actor, newest, { status: "active" })).statusCode).toBe(200);

    // A seat add-on changes what the workspace is entitled to (addonOutcome.changed), so the reconcile runs - under the
    // SAME prompt limits.
    f.stripeSubscription(workspaceId, { plan: "growth", held: [{ kind: "extra_seat", quantity: 1 }] });
    expect((await f.reconcile(workspaceId)).statusCode).toBe(200);
    expect((await promptRows(p!)).find((r) => r.id === newest)).toMatchObject({ status: "active", paused_by_downgrade_at: null });
    expect((await promptRows(p!)).find((r) => r.id === ps[0])).toMatchObject({ status: "paused", paused_by_downgrade_at: null });
    expect(await f.auditActions(workspaceId, "billing.downgrade.paused")).toHaveLength(1);
  });

  it("review round 2 · a PATCH that leaves a downgrade-paused prompt paused (paused -> paused) keeps the marker, so a later upgrade still resumes it", async () => {
    const { workspaceId, owner } = await f.newWorkspace("business");
    const [p] = await f.projects(workspaceId, 1);
    const ps = await promptsAt(workspaceId, p!, 41, 3000);
    spyEmail();
    await downgradeAtCutOver(workspaceId, owner, "growth");
    const newest = ps[40]!;
    expect((await promptRows(p!)).find((r) => r.id === newest)?.paused_by_downgrade_at).not.toBeNull();

    const actor = await f.enter(await f.ownerOf(workspaceId), workspaceId);
    expect((await patchPrompt(actor, newest, { status: "paused" })).statusCode).toBe(200);
    expect((await promptRows(p!)).find((r) => r.id === newest)?.paused_by_downgrade_at, "a no-op status is not a person's decision").not.toBeNull();

    await upgradeTo(workspaceId, "business");
    expect((await promptRows(p!)).find((r) => r.id === newest)).toMatchObject({ status: "active", paused_by_downgrade_at: null });
  });

  it("review round 2 · CONCURRENT resumes in different projects cannot both take the last workspace-wide slot (prompts.max_total)", async () => {
    const { workspaceId } = await f.newWorkspace("growth");
    // An over-limit workspace: 3 projects, each 3 active + 1 paused; the override caps the workspace at 10 active, so
    // 9 are active and ONE resume fits. Every project has room under its own 40.
    await overrideEntitlements(workspaceId, { "prompts.max_total": 10 });
    const ids = await f.projects(workspaceId, 3);
    const paused: string[] = [];
    for (const projectId of ids) {
      await promptsAt(workspaceId, projectId, 3, 500);
      const [extra] = await promptsAt(workspaceId, projectId, 1, 100);
      await db().query("UPDATE tracked_prompts SET status = 'paused' WHERE id = $1", [extra]);
      paused.push(extra!);
    }
    const actor = await f.enter(await f.ownerOf(workspaceId), workspaceId);
    const results = await Promise.all(paused.map((id) => patchPrompt(actor, id, { status: "active" })));
    const active = (await db().query<{ n: number }>("SELECT count(*)::int AS n FROM tracked_prompts WHERE workspace_id = $1 AND status = 'active' AND deleted_at IS NULL", [workspaceId])).rows[0]!.n;
    expect(active, "never above the cap").toBeLessThanOrEqual(10);
    expect(results.map((r) => r.statusCode).sort(), "exactly one resume fits").toEqual([200, 403, 403]);
    for (const r of results.filter((x) => x.statusCode !== 200)) expect(JSON.parse(r.body)).toMatchObject({ error: { code: "entitlement_exceeded", details: { key: "prompts.max_total" } } });
  });
  // ---- review round 3 ---------------------------------------------------------------------------------------------

  it("review round 3 · the confirmation names EXACTLY what the cut-over pauses (Growth -> Starter, A=20, B=20 newer): B with all 20 of its prompts, the total row none beyond them", async () => {
    const { workspaceId, owner } = await f.newWorkspace("growth");
    const [a, b] = await f.projects(workspaceId, 2);
    await promptsAt(workspaceId, a!, 20, 3000);
    await promptsAt(workspaceId, b!, 20, 2000);
    const preview = planChangePreviewResponseSchema.parse(dataOf(await f.post(owner, PREVIEW, { plan_key: "starter" })));
    const structural = preview.exceeds.filter((e) => e.kind === "structural");
    expect(structural).toEqual([
      { kind: "structural", key: "projects.max", limit: 1, current: 2, excess: 1, effect: "paused_at_period_end", paused: 1, items: [{ id: b, name: "P1", prompts: 20 }] },
      { kind: "structural", key: "prompts.max_total", limit: 30, current: 40, excess: 10, effect: "paused_at_period_end", paused: 0 },
    ]);

    spyEmail();
    await downgradeAtCutOver(workspaceId, owner, "starter");
    const pausedNow = (await db().query<{ n: number }>("SELECT count(*)::int AS n FROM tracked_prompts WHERE workspace_id = $1 AND paused_by_downgrade_at IS NOT NULL", [workspaceId])).rows[0]!.n;
    expect(pausedNow, "the cut-over paused what the preview named: 20 + 0").toBe(20);
    expect(await markedProjects(workspaceId)).toEqual([b]);
  });

  it("review round 3 · a pause caused by an ADD-ON removal (the plan did not move) emails that the add-ons changed, never that the workspace moved plan", async () => {
    const { workspaceId } = await f.newWorkspace("growth", { held: [{ kind: "extra_project", quantity: 1 }] });
    const ids = await f.projects(workspaceId, 4); // growth's 3 + the extra project
    const sent = spyEmail();
    f.stripeSubscription(workspaceId, { plan: "growth" }); // the extra project removed in the portal
    expect((await f.reconcile(workspaceId)).statusCode).toBe(200);
    expect(await markedProjects(workspaceId)).toEqual([ids[3]]);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.textBody).toMatch(/add-ons changed/);
    expect(sent[0]!.textBody).not.toMatch(/moved to the|changed plan/);
  });

  it("review round 3 · rewording a downgrade-paused prompt (text only) keeps it the plan's: the replacement carries the marker, and an upgrade resumes it", async () => {
    const { workspaceId, owner } = await f.newWorkspace("business");
    const [p] = await f.projects(workspaceId, 1);
    const ps = await promptsAt(workspaceId, p!, 41, 3000);
    spyEmail();
    await downgradeAtCutOver(workspaceId, owner, "growth");
    const newest = ps[40]!;
    expect((await promptRows(p!)).find((r) => r.id === newest)?.paused_by_downgrade_at).not.toBeNull();

    const actor = await f.enter(await f.ownerOf(workspaceId), workspaceId);
    const res = await patchPrompt(actor, newest, { text: `reworded ${randomUUID()}` });
    expect(res.statusCode, res.body).toBe(200);
    const replacement = (dataOf(res) as { prompt_id: string }).prompt_id;
    expect((await promptRows(p!)).find((r) => r.id === replacement), "only the wording changed, not who paused it").toMatchObject({ status: "paused" });
    expect((await promptRows(p!)).find((r) => r.id === replacement)?.paused_by_downgrade_at).not.toBeNull();
    expect((await promptRows(p!)).find((r) => r.id === newest)).toMatchObject({ status: "archived", paused_by_downgrade_at: null });

    await upgradeTo(workspaceId, "business");
    expect((await promptRows(p!)).find((r) => r.id === replacement)).toMatchObject({ status: "active", paused_by_downgrade_at: null });
  });

  // ---- review round 4 -------------------------------------------------------------------------------------------
  // ⚠ THE HAZARD (round-3 review, major): every OTHER door that makes a prompt `active` undoes the cut-over too. A manual
  // prompt (POST /projects/{id}/prompts) and a project created with supplied prompts (POST /projects) are inserted
  // `active`, and only the per-project SLOT cap was checked: after a cut-over that paused prompts for
  // `prompts.max_total`, a customer could type new active prompts into any project with slot room and end up tracking
  // more than the plan allows. And the shared row PATCH has a second door into `active` - an edit that also resumes.

  /** A workspace the cut-over left at exactly growth's 120 active (5 newest of P0 paused for `prompts.max_total`); every project has slot room. */
  async function atTheWorkspaceCap(projectsMax: number) {
    const { workspaceId } = await f.newWorkspace("business");
    await overrideEntitlements(workspaceId, { "projects.max": projectsMax });
    const owner = await f.enter(await f.ownerOf(workspaceId), workspaceId);
    const ids = await f.projects(workspaceId, 4);
    const p0 = [...(await promptsAt(workspaceId, ids[0]!, 35, 2000)), ...(await promptsAt(workspaceId, ids[0]!, 5, 5))];
    await promptsAt(workspaceId, ids[1]!, 40, 1500);
    await promptsAt(workspaceId, ids[2]!, 40, 1400);
    await promptsAt(workspaceId, ids[3]!, 5, 1300);
    spyEmail();
    await downgradeAtCutOver(workspaceId, owner, "growth");
    const paused = (await promptRows(ids[0]!)).filter((p) => p.paused_by_downgrade_at !== null).map((p) => p.id);
    expect(paused).toEqual(p0.slice(35));
    expect(await workspaceActive(workspaceId)).toBe(120);
    return { workspaceId, ids, p0, paused, actor: await f.enter(await f.ownerOf(workspaceId), workspaceId) };
  }
  const workspaceActive = async (workspaceId: string) =>
    (await db().query<{ n: number }>("SELECT count(*)::int AS n FROM tracked_prompts WHERE workspace_id = $1 AND status = 'active' AND deleted_at IS NULL", [workspaceId])).rows[0]!.n;

  it("review round 4 · POST /projects/{id}/prompts after a workspace-wide cut-over is REFUSED (prompts.max_total) in a project with slot room, writes nothing, and succeeds once an archive frees room", async () => {
    const { workspaceId, ids, p0, actor } = await atTheWorkspaceCap(4);
    const before = (await promptRows(ids[3]!)).length;

    const refused = await f.post(actor, `/projects/${ids[3]!}/prompts`, { text: `typed ${randomUUID()}` });
    expect(refused.statusCode, refused.body).toBe(403);
    expect(JSON.parse(refused.body)).toMatchObject({ error: { code: "entitlement_exceeded", details: { key: "prompts.max_total", limit: 120, current: 120 } } });
    expect((await promptRows(ids[3]!)).length, "a refused create writes nothing").toBe(before);
    expect(await workspaceActive(workspaceId)).toBe(120);

    expect((await patchPrompt(actor, p0[0]!, { status: "archived" })).statusCode).toBe(200);
    const created = await f.post(actor, `/projects/${ids[3]!}/prompts`, { text: `typed ${randomUUID()}` });
    expect(created.statusCode, created.body).toBe(201);
    expect(await workspaceActive(workspaceId)).toBe(120);
  });

  it("review round 4 · CONCURRENT manual creates in different projects cannot both take the last workspace-wide slot (prompts.max_total)", async () => {
    const { workspaceId } = await f.newWorkspace("growth");
    // 3 projects, 3 active each = 9; the override caps the workspace at 10 active, so ONE create fits. Every project has
    // slot room under its own 40.
    await overrideEntitlements(workspaceId, { "prompts.max_total": 10 });
    const ids = await f.projects(workspaceId, 3);
    for (const projectId of ids) await promptsAt(workspaceId, projectId, 3, 500);
    const actor = await f.enter(await f.ownerOf(workspaceId), workspaceId);
    const results = await Promise.all(ids.map((projectId) => f.post(actor, `/projects/${projectId}/prompts`, { text: `typed ${randomUUID()}` })));
    expect(await workspaceActive(workspaceId), "never above the cap").toBeLessThanOrEqual(10);
    expect(results.map((r) => r.statusCode).sort(), "exactly one create fits").toEqual([201, 403, 403]);
    for (const r of results.filter((x) => x.statusCode !== 201)) expect(JSON.parse(r.body)).toMatchObject({ error: { code: "entitlement_exceeded", details: { key: "prompts.max_total" } } });
  });

  it("review round 4 · POST /projects with supplied prompts after a workspace-wide cut-over is REFUSED (prompts.max_total) and creates no project; without prompts it is still accepted", async () => {
    // projects.max 5: a fifth project fits, so only the prompts can refuse it.
    const { workspaceId, actor } = await atTheWorkspaceCap(5);
    vi.spyOn(UrlGuard.prototype, "validateAndNormalize").mockResolvedValue({ rootDomain: "example.com" });
    const projectCount = async () => (await projectRows(workspaceId)).length;

    const refused = await f.post(actor, "/projects", { root_url: "https://example.com", prompts: [{ text: `seed ${randomUUID()}` }] });
    expect(refused.statusCode, refused.body).toBe(403);
    expect(JSON.parse(refused.body)).toMatchObject({ error: { code: "entitlement_exceeded", details: { key: "prompts.max_total", limit: 120, current: 120 } } });
    expect(await projectCount(), "the whole creation is refused").toBe(4);
    expect(await workspaceActive(workspaceId)).toBe(120);

    const plain = await f.post(actor, "/projects", { root_url: "https://example.com" });
    expect(plain.statusCode, plain.body).toBe(202);
    expect(await projectCount()).toBe(5);
  });

  // ---- review round 5 -------------------------------------------------------------------------------------------
  // ⚠ THE HAZARD (round-4 review, major): POST /projects with supplied prompts checked the caps against the entitlements
  // the guard pinned when the request STARTED, resolved before it took the workspace lock. A creation that waited on the
  // lock while a cut-over lowered the plan then counted the post-cut-over actives against the OLD plan's limits and
  // inserted its prompts `active`, leaving the workspace above the plan with nothing to re-pause it. Deterministic: the
  // "webhook" holds the workspace lock FIRST, the creation is seen waiting on it, and only then is the plan lowered.
  it("review round 5 · POST /projects with supplied prompts that waited on the cut-over's workspace lock is held to the NEW limits (prompts.max_total), not the ones it started with", async () => {
    const { workspaceId } = await f.newWorkspace("growth");
    // Before: max_total 14 with 12 active, so the creation's 2 prompts fit. The cut-over lowers it to 10 and pauses 2.
    await overrideEntitlements(workspaceId, { "prompts.max_total": 14, "projects.max": 10 });
    const ids = await f.projects(workspaceId, 3);
    for (const [i, projectId] of ids.entries()) await promptsAt(workspaceId, projectId, 4, 3000 - i * 100);
    expect(await workspaceActive(workspaceId)).toBe(12);
    const actor = await f.enter(await f.ownerOf(workspaceId), workspaceId);
    vi.spyOn(UrlGuard.prototype, "validateAndNormalize").mockResolvedValue({ rootDomain: "example.com" });

    const webhook = new Client({ connectionString: process.env.DATABASE_URL });
    await webhook.connect();
    try {
      const webhookPid = (await webhook.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      await webhook.query("BEGIN");
      await webhook.query("SELECT 1 FROM workspaces WHERE id = $1 FOR UPDATE", [workspaceId]);

      const create = f.post(actor, "/projects", { root_url: "https://example.com", prompts: [{ text: `seed ${randomUUID()}` }, { text: `seed ${randomUUID()}` }] });
      // Blocked BY THE "WEBHOOK" BACKEND, not by any other spec's waiter (see the round-3 deadlock case below).
      const deadline = Date.now() + 10_000;
      for (;;) {
        const waiting = (await db().query<{ n: number }>("SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))", [webhookPid])).rows[0]!.n;
        if (waiting > 0) break;
        if (Date.now() > deadline) throw new Error("the creation never waited on the webhook's workspace lock");
        await new Promise((r) => setTimeout(r, 20));
      }
      // The cut-over: the entitlement version bump apply-plan.ts makes, then the reconcile, in the one transaction.
      await webhook.query("UPDATE workspaces SET entitlement_overrides = $2::jsonb, entitlement_version = entitlement_version + 1 WHERE id = $1", [
        workspaceId,
        JSON.stringify({ "prompts.max_total": 10, "projects.max": 10 }),
      ]);
      await reconcileDowngradePause(webhook, workspaceId);
      await webhook.query("COMMIT");

      const res = await create;
      expect(res.statusCode, res.body).toBe(403);
      expect(JSON.parse(res.body)).toMatchObject({ error: { code: "entitlement_exceeded", details: { key: "prompts.max_total", limit: 10, current: 10 } } });
      expect(await workspaceActive(workspaceId), "never above the plan the cut-over adopted").toBe(10);
      expect((await projectRows(workspaceId)).length, "the whole creation is refused").toBe(3);
    } finally {
      await webhook.end();
    }
  });

  it("review round 5 · CONCURRENT POST /projects with supplied prompts cannot both take the last workspace-wide slot (prompts.max_total)", async () => {
    const { workspaceId } = await f.newWorkspace("growth");
    // 3 projects, 3 active each = 9; the override caps the workspace at 10 active, so ONE creation's prompt fits.
    await overrideEntitlements(workspaceId, { "prompts.max_total": 10, "projects.max": 10 });
    const ids = await f.projects(workspaceId, 3);
    for (const projectId of ids) await promptsAt(workspaceId, projectId, 3, 500);
    const actor = await f.enter(await f.ownerOf(workspaceId), workspaceId);
    // A distinct domain per creation, so a slug race cannot stand in for the cap.
    vi.spyOn(UrlGuard.prototype, "validateAndNormalize").mockImplementation(async (url: string) => ({ rootDomain: new URL(url).hostname }));
    const results = await Promise.all(
      ["a", "b", "c"].map((d) => f.post(actor, "/projects", { root_url: `https://${d}-${randomUUID().slice(0, 8)}.example.com`, prompts: [{ text: `seed ${randomUUID()}` }] })),
    );
    expect(await workspaceActive(workspaceId), "never above the cap").toBeLessThanOrEqual(10);
    expect(results.map((r) => r.statusCode).sort(), "exactly one creation fits").toEqual([202, 403, 403]);
    for (const r of results.filter((x) => x.statusCode !== 202)) expect(JSON.parse(r.body)).toMatchObject({ error: { code: "entitlement_exceeded", details: { key: "prompts.max_total" } } });
    expect((await projectRows(workspaceId)).length, "the refused creations create no project").toBe(4);
  });

  it("review round 4 · the shared row PATCH's EDIT door: rewording a downgrade-paused prompt AND resuming it in one request is held to prompts.max_total, and changes nothing when refused", async () => {
    const { workspaceId, ids, paused, actor } = await atTheWorkspaceCap(4);
    const target = paused[0]!;
    const before = await promptRows(ids[0]!);

    const refused = await patchPrompt(actor, target, { text: `reworded ${randomUUID()}`, status: "active" });
    expect(refused.statusCode, refused.body).toBe(403);
    expect(JSON.parse(refused.body)).toMatchObject({ error: { code: "entitlement_exceeded", details: { key: "prompts.max_total", limit: 120, current: 120 } } });
    expect(await promptRows(ids[0]!), "no replacement row, the original still paused by the plan").toEqual(before);
    expect(await workspaceActive(workspaceId)).toBe(120);
  });

  // ⚠ THE HAZARD (review round 3, major): a lock-order inversion. The cut-over transaction locks the workspace, then the
  // wallet (applyPlanChange), then every project row (reconcileDowngradePause). A charged archived -> paused PATCH that
  // took the PROJECT lock without the workspace lock, then debited the wallet, closed a cycle: Postgres aborts one of
  // them with 40P01 and either the customer's charged change or the cut-over dies. Deterministic: the "webhook" holds
  // the workspace and wallet locks FIRST, the PATCH is seen waiting, and only then does the reconcile take the projects.
  it("review round 3 · a charged archived -> paused PATCH racing the cut-over never deadlocks (40P01): both commit", async () => {
    const { workspaceId } = await f.newWorkspace("growth");
    const [p] = await f.projects(workspaceId, 1);
    // The free ten are spent, so leaving `archived` is charged (1 credit) and debits the wallet.
    const free = await promptsAt(workspaceId, p!, 10, 500);
    await db().query("UPDATE tracked_prompts SET first_activated_at = now() WHERE id = ANY($1::uuid[])", [free]);
    const [candidate] = await promptsAt(workspaceId, p!, 1, 100);
    await db().query("UPDATE tracked_prompts SET status = 'archived' WHERE id = $1", [candidate]);
    const actor = await f.enter(await f.ownerOf(workspaceId), workspaceId);

    const webhook = new Client({ connectionString: process.env.DATABASE_URL });
    await webhook.connect();
    let webhookError: unknown;
    try {
      const webhookPid = (await webhook.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      await webhook.query("BEGIN");
      await webhook.query("SELECT 1 FROM workspaces WHERE id = $1 FOR UPDATE", [workspaceId]);
      await webhook.query("SELECT 1 FROM credit_wallets WHERE workspace_id = $1 FOR UPDATE", [workspaceId]);

      const patch = harness.app().inject({
        method: "PATCH",
        url: apiUrl(`/prompts/${candidate!}`),
        cookies: f.cookies(actor),
        headers: { [CSRF_HEADER_NAME]: actor.csrfToken, "content-type": "application/json", "idempotency-key": randomUUID(), [CONFIRMED_CREDITS_HEADER]: "1" },
        payload: { status: "paused" },
      });
      // Wait until the PATCH is blocked BY THE "WEBHOOK" BACKEND (review round 4): a cluster-wide `pg_locks WHERE NOT
      // granted` was satisfied by any other spec's waiter, so the reconcile could run before the PATCH ever queued and
      // the test passed without forming the interleaving it exists to check.
      const deadline = Date.now() + 10_000;
      for (;;) {
        const waiting = (await db().query<{ n: number }>("SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))", [webhookPid])).rows[0]!.n;
        if (waiting > 0) break;
        if (Date.now() > deadline) throw new Error("the PATCH never waited on the webhook's locks");
        await new Promise((r) => setTimeout(r, 20));
      }
      try {
        await reconcileDowngradePause(webhook, workspaceId);
        await webhook.query("COMMIT");
      } catch (error) {
        webhookError = error;
        await webhook.query("ROLLBACK");
      }
      const res = await patch;
      expect((webhookError as { code?: string } | undefined)?.code, "the cut-over is never the deadlock victim").toBeUndefined();
      expect(res.statusCode, res.body).toBe(200);
      expect(dataOf(res)).toMatchObject({ status: "paused", credits_charged: 1 });
    } finally {
      await webhook.end();
    }
  });
});
