import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { downgradeKeepResponseSchema, planChangePreviewResponseSchema } from "../../contracts/billing/index.js";
import { uuidV7 } from "../../src/lib/ids/uuidv7.js";
import { LoggingEmailSenderAdapter } from "../../src/modules/identity/adapters/logging-email-sender.adapter.js";
import type { EmailMessage } from "../../src/modules/identity/ports/email-sender.js";
import { dataOf } from "../support/envelope.js";
import { usePlanChangeFixture, type Actor, type PlanName } from "../support/plan-change-fixture.js";

// STORY-077 D2 — the customer chooses what to keep before a downgrade's cut-over (owner approved 2026-10-20), and with no
// choice the cut-over keeps the MOST RECENTLY ACTIVE (owner decision 2026-10-20). End to end on the real ApiModule, a real
// Postgres with RLS in force and the fake Stripe gateway; the cut-over is the signature-verified webhook.
//
// Hazards:
//   * the cut-over ignores the choice (pauses by its own rule), or honours a choice made for ANOTHER downgrade;
//   * a choice over the target's limits is recorded, or one naming a prompt outside the kept projects;
//   * the choice outlives its downgrade (a cancel, or the cut-over itself, leaves it behind for the next one);
//   * with no choice, a project captured yesterday is paused because it was created last;
//   * the preview names projects the cut-over will not pause;
//   * someone without billing:write records a choice.

describe("STORY-077 D2 · the keep choice and the most-recently-active default", () => {
  const f = usePlanChangeFixture();
  const { gateway, harness } = f;
  const PREVIEW = "/billing/subscription/change/preview";
  const CHANGE = "/billing/subscription/change";
  const KEEP = "/billing/subscription/change/keep";
  const db = () => harness.db();
  const errorOf = (res: { json(): unknown }) => (res.json() as { error: { code: string; details?: Record<string, unknown> } }).error;

  /** `n` prompts in `projectId`, the i-th created `n - i` minutes ago (index n-1 is the newest). */
  async function prompts(workspaceId: string, projectId: string, n: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const text = `prompt ${String(i)} ${randomUUID()}`;
      const r = await db().query<{ id: string }>(
        `INSERT INTO tracked_prompts (workspace_id, project_id, text, text_hash, intent_archetype, funnel_stage, status, created_at)
         VALUES ($1, $2, $3, sha256(convert_to($3, 'UTF8')), 'recommendation', 'consideration', 'active', now() - ($4 || ' minutes')::interval) RETURNING id`,
        [workspaceId, projectId, text, String(n - i)],
      );
      ids.push(r.rows[0]!.id);
    }
    return ids;
  }

  /** A capture run of `projectId` that finished `minutesAgo` minutes ago (status `completed`). */
  async function finishedRun(workspaceId: string, projectId: string, minutesAgo: number, status = "completed"): Promise<void> {
    await db().query(
      `INSERT INTO capture_runs (workspace_id, project_id, trigger, engine_keys, status, started_at, finished_at)
       VALUES ($1, $2, 'scheduled', ARRAY['gemini'], $3, now() - (($4 + 5) || ' minutes')::interval, now() - ($4 || ' minutes')::interval)`,
      [workspaceId, projectId, status, String(minutesAgo)],
    );
  }

  /** An answer capture of `promptId` captured `minutesAgo` minutes ago (status `parsed`). */
  async function captured(workspaceId: string, projectId: string, promptId: string, minutesAgo: number): Promise<void> {
    const id = uuidV7();
    await db().query(
      `INSERT INTO answer_captures
         (id, workspace_id, project_id, run_id, prompt_id, engine_key, captured_at, capture_mode, adapter_version, normalizer_version, content_hash, payload, flags, cache_layer, status, brand_present)
       VALUES ($1, $2, $3, $4, $5, 'gemini', now() - ($6 || ' minutes')::interval, 'api', '1.0.0', '1.0.0', $7, '{}'::jsonb, '{}', 'live', 'parsed', true)`,
      [id, workspaceId, projectId, uuidV7(), promptId, String(minutesAgo), createHash("sha256").update(id).digest()],
    );
  }

  const projectState = async (workspaceId: string) =>
    (await db().query<{ id: string; status: string; marked: boolean }>(
      "SELECT id, status, paused_by_downgrade_at IS NOT NULL AS marked FROM projects WHERE workspace_id = $1 ORDER BY created_at, id",
      [workspaceId],
    )).rows;
  const pausedPrompts = async (projectId: string) =>
    (await db().query<{ id: string }>("SELECT id FROM tracked_prompts WHERE project_id = $1 AND paused_by_downgrade_at IS NOT NULL ORDER BY created_at, id", [projectId])).rows.map((r) => r.id);
  const keepColumn = async (workspaceId: string) =>
    (await db().query<{ downgrade_keep: Record<string, unknown> | null }>("SELECT downgrade_keep FROM subscriptions WHERE workspace_id = $1", [workspaceId])).rows[0]!.downgrade_keep;

  function spyEmail(): EmailMessage[] {
    const sent: EmailMessage[] = [];
    vi.spyOn(LoggingEmailSenderAdapter.prototype, "send").mockImplementation(async (message: EmailMessage) => {
      sent.push(message);
    });
    return sent;
  }
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function scheduleDowngrade(owner: Actor, target: PlanName) {
    const res = await f.post(owner, CHANGE, { plan_key: target });
    expect(res.statusCode, res.body).toBe(202);
  }
  /** Stripe's cut-over for the downgrade scheduled last: phase 1 has started. */
  async function cutOver(workspaceId: string, target: PlanName) {
    const call = gateway.downgrades.at(-1)!;
    const start = f.nowSeconds() - 60;
    f.stripeSubscription(workspaceId, { plan: target, metadata: { plan_change_intent_id: String(call.metadata.plan_change_intent_id) }, periodStart: start, periodEnd: start + 30 * 86_400 });
    const delivered = await f.reconcile(workspaceId);
    expect(delivered.statusCode, delivered.body).toBe(200);
    expect((await f.planOf(workspaceId)).plan_key).toBe(target);
  }

  it("GET and PUT answer 409 plan_change_not_pending when no downgrade is pending", async () => {
    const { owner } = await f.newWorkspace("business");
    const got = await f.get(owner, KEEP);
    expect(got.statusCode, got.body).toBe(409);
    expect(errorOf(got)).toMatchObject({ code: "conflict", details: { reason: "plan_change_not_pending" } });
    const put = await f.put(owner, KEEP, { project_ids: [], prompt_ids: [] });
    expect(put.statusCode, put.body).toBe(409);
    expect(errorOf(put).details).toMatchObject({ reason: "plan_change_not_pending" });
  });

  it("scenario 2 · GET names the target's limits, every keepable project and prompt, and a default that keeps the most recently active", async () => {
    const { workspaceId, owner } = await f.newWorkspace("business");
    const ids = await f.projects(workspaceId, 6);
    await db().query("UPDATE projects SET status = 'paused' WHERE id = $1", [ids[5]]); // a person's pause: never keepable
    await finishedRun(workspaceId, ids[4]!, 60);
    await finishedRun(workspaceId, ids[3]!, 120);
    await finishedRun(workspaceId, ids[2]!, 10, "failed"); // a failed run is not activity
    const big = await prompts(workspaceId, ids[0]!, 45);
    await captured(workspaceId, ids[0]!, big[0]!, 30);
    await scheduleDowngrade(owner, "growth");

    const view = downgradeKeepResponseSchema.parse(dataOf(await f.get(owner, KEEP)));
    expect(view.target_plan_key).toBe("growth");
    expect(view.limits).toEqual({ projects: 3, prompts_total: 120, prompts_per_project: 40 });
    expect(view.projects.map((p) => p.id), "keepable, most recently active first").toEqual([ids[4], ids[3], ids[0], ids[1], ids[2]]);
    expect(view.projects[0]!.last_active_at).not.toBeNull();
    expect(view.projects.find((p) => p.id === ids[2])!.last_active_at, "a failed run is not activity").toBeNull();
    expect(view.projects.find((p) => p.id === ids[0])!.prompts.map((p) => p.id)[0], "the captured prompt first").toBe(big[0]);
    // Six projects (the person-paused one counts) against 3: P4 and P3 (activity), then P0 (oldest) are kept.
    expect(view.default.project_ids).toEqual([ids[4], ids[3], ids[0]]);
    expect(view.default.prompt_ids, "P0 keeps its captured prompt and the 39 oldest of the rest").toEqual([big[0], ...big.slice(1, 40)]);
    expect(view.choice).toBeNull();
  });

  it("PUT refuses a choice over the target's limits, a prompt outside the kept projects, or an unknown id with 400 validation_failed, and records nothing", async () => {
    const { workspaceId, owner } = await f.newWorkspace("business");
    const ids = await f.projects(workspaceId, 5);
    const big = await prompts(workspaceId, ids[0]!, 45);
    await scheduleDowngrade(owner, "growth");

    const cases: Array<[string, unknown, string]> = [
      ["four projects against growth's 3", { project_ids: ids.slice(0, 4), prompt_ids: [] }, "project_ids"],
      ["41 prompts in one project against 40", { project_ids: ids.slice(0, 3), prompt_ids: big.slice(0, 41) }, "prompt_ids"],
      ["a prompt whose project is not kept", { project_ids: ids.slice(1, 4), prompt_ids: [big[0]] }, "prompt_ids"],
      ["an unknown project", { project_ids: [randomUUID()], prompt_ids: [] }, "project_ids"],
    ];
    for (const [label, body, field] of cases) {
      const res = await f.put(owner, KEEP, body);
      expect(res.statusCode, `${label}: ${res.body}`).toBe(400);
      expect(errorOf(res).code, label).toBe("validation_failed");
      expect(JSON.stringify(errorOf(res).details), label).toContain(field);
    }
    expect(await keepColumn(workspaceId)).toBeNull();
  });

  it("PUT needs billing:write: a manager is refused 403 and nothing is recorded", async () => {
    const { workspaceId, owner } = await f.newWorkspace("business");
    const ids = await f.projects(workspaceId, 4);
    await scheduleDowngrade(owner, "growth");
    const manager = await f.memberIn(workspaceId, "manager");
    const res = await f.put(manager, KEEP, { project_ids: ids.slice(0, 3), prompt_ids: [] });
    expect(res.statusCode, res.body).toBe(403);
    expect(await keepColumn(workspaceId)).toBeNull();
  });

  it("scenario 2 · the choice is honoured at the cut-over: the chosen are kept, everything else paused, the email says so, and the choice is spent with the intent", async () => {
    const { workspaceId, owner } = await f.newWorkspace("business");
    const ids = await f.projects(workspaceId, 5);
    const big = await prompts(workspaceId, ids[4]!, 45);
    // Activity that the DEFAULT would follow (keep P0, P1), so a cut-over that ignores the choice is visible.
    await finishedRun(workspaceId, ids[0]!, 5);
    await finishedRun(workspaceId, ids[1]!, 6);
    await scheduleDowngrade(owner, "growth");

    const chosen = { project_ids: [ids[2], ids[3], ids[4]], prompt_ids: big.slice(5) };
    const put = await f.put(owner, KEEP, chosen);
    expect(put.statusCode, put.body).toBe(200);
    const view = downgradeKeepResponseSchema.parse(dataOf(put));
    expect(view.choice).toMatchObject({ project_ids: chosen.project_ids, prompt_ids: chosen.prompt_ids });
    expect(downgradeKeepResponseSchema.parse(dataOf(await f.get(owner, KEEP))).choice).toMatchObject({ project_ids: chosen.project_ids });
    expect(await f.auditActions(workspaceId, "billing.plan_change.keep_chosen")).toHaveLength(1);

    const sent = spyEmail();
    await cutOver(workspaceId, "growth");
    expect((await projectState(workspaceId)).map((p) => [p.id, p.status, p.marked])).toEqual([
      [ids[0], "paused", true],
      [ids[1], "paused", true],
      [ids[2], "active", false],
      [ids[3], "active", false],
      [ids[4], "active", false],
    ]);
    expect(await pausedPrompts(ids[4]!), "the five not chosen").toEqual(big.slice(0, 5));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.textBody).toMatch(/you did not choose to keep/);
    expect(await keepColumn(workspaceId), "spent with its intent").toBeNull();
    expect(await f.intentOf(workspaceId)).toBeNull();
  });

  it("scenario 3 · with no choice the cut-over keeps the most recently active (finished runs, latest captures), then the slice-A order", async () => {
    const { workspaceId, owner } = await f.newWorkspace("business");
    const ids = await f.projects(workspaceId, 5);
    await finishedRun(workspaceId, ids[4]!, 30);
    await finishedRun(workspaceId, ids[3]!, 40, "partial");
    const big = await prompts(workspaceId, ids[0]!, 45);
    await captured(workspaceId, ids[0]!, big[44]!, 3);
    await captured(workspaceId, ids[0]!, big[43]!, 4);
    await scheduleDowngrade(owner, "growth");
    const sent = spyEmail();
    await cutOver(workspaceId, "growth");

    expect((await projectState(workspaceId)).filter((p) => p.marked).map((p) => p.id), "P1 and P2: never captured, the newest of those").toEqual([ids[1], ids[2]]);
    expect(await pausedPrompts(ids[0]!), "the never-captured, newest first: 38..42").toEqual(big.slice(38, 43));
    expect(sent[0]!.textBody).toMatch(/least recently active/);
  });

  it("the preview names the projects the cut-over will pause: the least recently active, not the newest", async () => {
    const { workspaceId, owner } = await f.newWorkspace("business");
    const ids = await f.projects(workspaceId, 5);
    await finishedRun(workspaceId, ids[4]!, 30);
    await finishedRun(workspaceId, ids[3]!, 40);
    const preview = planChangePreviewResponseSchema.parse(dataOf(await f.post(owner, PREVIEW, { plan_key: "growth" })));
    const projects = preview.exceeds.find((e) => e.kind === "structural" && e.key === "projects.max");
    expect(projects).toMatchObject({ paused: 2, items: [{ id: ids[2], name: "P2" }, { id: ids[1], name: "P1" }] });
  });

  it("cancelling the downgrade clears the choice, and a new downgrade starts with none", async () => {
    const { workspaceId, owner } = await f.newWorkspace("business");
    const ids = await f.projects(workspaceId, 4);
    await scheduleDowngrade(owner, "growth");
    expect((await f.put(owner, KEEP, { project_ids: ids.slice(1), prompt_ids: [] })).statusCode).toBe(200);
    expect(await keepColumn(workspaceId)).not.toBeNull();

    const cancelled = await f.del(owner, CHANGE);
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(await keepColumn(workspaceId)).toBeNull();

    await scheduleDowngrade(owner, "growth");
    expect(downgradeKeepResponseSchema.parse(dataOf(await f.get(owner, KEEP))).choice).toBeNull();
  });
});
