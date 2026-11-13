import type { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { finalizeRun } from "../../src/lib/capture/finalize-run.js";
import { readRunProgress } from "../../src/lib/capture/run-progress.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";
import { addCapture, addPrompt, addRun, addTenant, chargeRun, startRaceDb, truncateAll, type RaceDb, type Tenant } from "../support/run-race-fixture.js";

// STORY-089 AC "A long-running command ... lands in the notification centre on completion" (FR-CMD-06, test scenario 17). The command bar's long-running
// command is a manual deep scan; the run's single finalisation (`finalizeRun`, shared by the last live cell and the stuck-run reaper) writes ONE in-app
// notification for the member who started it. A scheduled run was nobody's command and notifies no one.

describe("STORY-089 · scenario 17 - a finished manual run lands in the notification centre", () => {
  let rig: RaceDb;
  let db: Client;

  beforeAll(async () => {
    rig = await startRaceDb();
    db = rig.db;
  }, 300_000);
  afterAll(async () => {
    await rig.stop();
  });
  beforeEach(async () => {
    await truncateAll(db);
  });

  const finalise = (t: Tenant, runId: string) => withTenantContext(db, { workspaceId: t.ws, actorId: SYSTEM_ACTOR_ID }, async (tx) => finalizeRun(tx, t.ws, await readRunProgress(tx, runId)));
  const notes = async (t: Tenant) => (await db.query<{ kind: string; severity: string; user_id: string | null; project_id: string | null; title: string; body: string | null; payload: Record<string, unknown>; channels: string[]; event_key: string }>("SELECT kind, severity, user_id, project_id, title, body, payload, channels, event_key FROM notifications WHERE workspace_id = $1", [t.ws])).rows;
  const startedBy = (run: string, user: string | null) => db.query("UPDATE capture_runs SET triggered_by = $2 WHERE id = $1", [run, user]);

  it("scenario 17 - a completed manual run writes one in-app notification, addressed to the member who started it, linking the run", async () => {
    const t = await addTenant(db);
    const run = await addRun(db, t, { planned: 1 });
    await startedBy(run, t.user);
    await addCapture(db, t, run, await addPrompt(db, t), { sampleIndex: 0 });
    await finalise(t, run);
    const rows = await notes(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "run.completed", severity: "info", user_id: t.user, project_id: t.project, channels: ["in_app"], event_key: `run.completed:${run}` });
    expect(rows[0]!.payload).toMatchObject({ run_id: run, status: "completed", captured: 1, failed: 0, deep_link: { path: `/p/${t.project}/overview`, query: { run } } });
  });

  it("scenario 17 - the notification is written once per run: a second finalisation adds nothing", async () => {
    const t = await addTenant(db);
    const run = await addRun(db, t, { planned: 1 });
    await startedBy(run, t.user);
    await addCapture(db, t, run, await addPrompt(db, t), { sampleIndex: 0 });
    await finalise(t, run);
    expect(await finalise(t, run)).toBeNull();
    expect(await notes(t)).toHaveLength(1);
  });

  it("scenario 17 - a run that delivered nothing is a warning that says it was refunded, with 0 captured (0, not absent)", async () => {
    const t = await addTenant(db);
    const run = await addRun(db, t, { planned: 2 });
    await chargeRun(db, t, run);
    await startedBy(run, t.user);
    await db.query("UPDATE capture_runs SET failed_cells = 2 WHERE id = $1", [run]);
    await finalise(t, run);
    const [row] = await notes(t);
    expect(row).toMatchObject({ kind: "run.completed", severity: "warning" });
    expect(row!.payload).toMatchObject({ status: "failed", captured: 0 });
    expect(row!.body).toMatch(/refunded/i);
  });

  it("scenario 17 - a partial run is stated as partial and is not described as refunded", async () => {
    const t = await addTenant(db);
    const run = await addRun(db, t, { planned: 2 });
    await chargeRun(db, t, run);
    await startedBy(run, t.user);
    await addCapture(db, t, run, await addPrompt(db, t), { sampleIndex: 0 });
    await db.query("UPDATE capture_runs SET failed_cells = 1 WHERE id = $1", [run]);
    await finalise(t, run);
    const [row] = await notes(t);
    expect(row!.payload).toMatchObject({ status: "partial", captured: 1, failed: 1 });
    expect(row!.body ?? "").not.toMatch(/refunded/i);
  });

  it("scenario 17 - a scheduled run, or a manual one with no human behind it, notifies no one", async () => {
    const t = await addTenant(db);
    const scheduled = await addRun(db, t, { planned: 1, trigger: "scheduled" });
    await startedBy(scheduled, t.user);
    await addCapture(db, t, scheduled, await addPrompt(db, t), { sampleIndex: 0 });
    await finalise(t, scheduled);
    const system = await addRun(db, t, { planned: 1 });
    await addCapture(db, t, system, await addPrompt(db, t), { sampleIndex: 0 });
    await finalise(t, system);
    expect(await notes(t)).toHaveLength(0);
  });

  it("scenario 17 - the notification text never carries the workspace's name", async () => {
    const t = await addTenant(db);
    const run = await addRun(db, t, { planned: 1 });
    await startedBy(run, t.user);
    await addCapture(db, t, run, await addPrompt(db, t), { sampleIndex: 0 });
    await finalise(t, run);
    const [row] = await notes(t);
    expect(JSON.stringify(row)).not.toContain("Secret Co Name");
  });
});
