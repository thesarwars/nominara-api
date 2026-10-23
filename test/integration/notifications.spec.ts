import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { Job } from "bullmq";
import { Client, Pool, type ClientBase } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { BREAKGLASS_ROLE, RUNTIME_ROLES } from "../../src/db/conventions.js";
import { MIGRATIONS_DIR, migrateUp } from "../../src/db/migrate-runner.js";
import { findDigestTargets, runNotifySweep } from "../../src/lib/notifications/notify-sweep.js";
import type { NotifyDispatchPayload } from "../../src/lib/notifications/routing.js";
import { writeNotification, type NotificationInput } from "../../src/lib/notifications/writer.js";
import { notifyQuotaThresholds } from "../../src/lib/notifications/thresholds.js";
import { signQueueJobPayload } from "../../src/lib/queue/envelope.js";
import { createNotifyDispatchHandler } from "../../src/lib/queue/handlers/notify-dispatch.handler.js";
import type { RotatingSigningKeys } from "../../src/lib/queue/signing.js";
import { topologyFor } from "../../src/lib/queue/topology.js";
import { createJobProcessor } from "../../src/lib/queue/worker-factory.js";
import { NotificationsService, type Viewer } from "../../src/modules/notifications/notifications.service.js";
import type { EmailMessage, EmailSender } from "../../src/modules/identity/ports/email-sender.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";

// STORY-068 — notifications infrastructure on a real Postgres with RLS IN FORCE: every tenant read and write below runs as
// `nominara_app` inside a real tenant transaction (the role production runs as), the sweep as the owner. Scenario numbers
// are STORY-068's Test scenarios table.
//
// The notify.dispatch worker is driven the way src/worker.ts drives it: `createJobProcessor` on the queue's topology
// entry, a pooled connection per phase, a signed envelope.

describe("STORY-068 · notifications, read state, digests and dispatch", () => {
  let container: StartedPostgreSqlContainer;
  let owner: Client;
  let appPool: Pool;
  let workspaceId: string;
  let otherWorkspaceId: string;
  let projectA: string;
  let projectB: string;
  const users: Record<string, string> = {};
  const KEYS: RotatingSigningKeys = { current: { kid: "ntf-it", key: Buffer.alloc(32, 7) } };
  const service = new NotificationsService();

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18").withDatabase("nominara_test").withUsername("nominara").withPassword("nominara").start();
    owner = new Client({ connectionString: container.getConnectionUri() });
    await owner.connect();
    await migrateUp(owner, MIGRATIONS_DIR);
    for (const role of [...RUNTIME_ROLES, BREAKGLASS_ROLE]) await owner.query(`ALTER ROLE ${role} PASSWORD ${owner.escapeLiteral(resolvePassword(role, {}))}`);
    appPool = new Pool({
      host: container.getHost(),
      port: container.getMappedPort(5432),
      database: container.getDatabase(),
      user: "nominara_app",
      password: resolvePassword("nominara_app", {}),
      max: 3,
    });
  }, 300_000);

  afterAll(async () => {
    await appPool.end();
    await owner.end();
    await container.stop();
  });

  async function member(ws: string, name: string, role: string, extra: { scope?: string[] | null; cadence?: string | null } = {}): Promise<string> {
    const id = randomUUID();
    await owner.query("INSERT INTO users (id,email,email_verified_at) VALUES ($1,$2,now())", [id, `${name}-${id.slice(0, 6)}@example.com`]);
    await owner.query("INSERT INTO workspace_members (workspace_id,user_id,role,project_scope,digest_cadence) VALUES ($1,$2,$3,$4,$5)", [
      ws, id, role, extra.scope ?? null, extra.cadence ?? null,
    ]);
    users[name] = id;
    return id;
  }

  beforeEach(async () => {
    await owner.query("TRUNCATE notification_emails, notification_reads, notifications, usage_counters, projects, workspace_members, users, workspaces CASCADE");
    workspaceId = randomUUID();
    otherWorkspaceId = randomUUID();
    for (const [id, tz] of [[workspaceId, "UTC"], [otherWorkspaceId, "Asia/Dhaka"]] as const) {
      await owner.query("INSERT INTO workspaces (id,name,slug,plan_key,timezone) VALUES ($1,'W',$2,'growth',$3)", [id, `w-${id.slice(0, 8)}`, tz]);
    }
    projectA = randomUUID();
    projectB = randomUUID();
    for (const id of [projectA, projectB]) {
      await owner.query("INSERT INTO projects (id,workspace_id,name,slug,root_url,root_domain) VALUES ($1,$2,'P',$3,'https://p.com','p.com')", [id, workspaceId, `p-${id.slice(0, 8)}`]);
    }
    await member(workspaceId, "owner", "owner");
    await member(workspaceId, "admin", "admin");
    await member(workspaceId, "analyst", "analyst");
    await member(workspaceId, "scoped", "manager", { scope: [projectA] });
    await member(otherWorkspaceId, "stranger", "owner");
  });

  /** A real tenant transaction as `nominara_app`. */
  async function inTenant<T>(ws: string, actorId: string, fn: (tx: ClientBase) => Promise<T>): Promise<T> {
    const client = await appPool.connect();
    try {
      return await withTenantContext(client, { workspaceId: ws, actorId }, () => fn(client));
    } finally {
      client.release();
    }
  }

  const viewer = (name: string, role: string, projectScope: string[] | null = null): Viewer => ({ userId: users[name]!, role, projectScope });
  const write = (input: Partial<NotificationInput> & { eventKey: string }, enqueue?: Parameters<typeof writeNotification>[2]) =>
    inTenant(workspaceId, SYSTEM_ACTOR_ID, (tx) =>
      writeNotification(tx, { workspaceId, projectId: null, userId: null, kind: "alert.test", severity: "warning", title: "T", body: null, ...input }, enqueue ?? {}),
    );
  const list = (name: string, role: string, scope: string[] | null = null, unread = "false") =>
    inTenant(workspaceId, users[name]!, () => service.list(viewer(name, role, scope), { limit: 50, unread: unread as "true" | "false" }));

  function processor(sender: EmailSender) {
    return createJobProcessor(topologyFor("notify.dispatch"), {
      keys: KEYS,
      getClient: () => appPool.connect(),
      releaseClient: (client) => (client as unknown as { release(): void }).release(),
      process: createNotifyDispatchHandler({ pool: appPool, env: {} as never }, { sender, enqueue: async () => undefined }),
    });
  }
  const jobFor = (ws: string, payload: NotifyDispatchPayload): Job =>
    ({ id: randomUUID(), data: signQueueJobPayload({ ...payload, workspaceId: ws, kid: KEYS.current.kid }, KEYS.current.key) }) as unknown as Job;
  function recordingSender(fail = { value: false }) {
    const sent: EmailMessage[] = [];
    const sender: EmailSender = {
      send: async (message) => {
        // ADR-0003 / NFR-ARCH-04: nothing of the worker's pool is checked out while the provider is called.
        expect(appPool.totalCount - appPool.idleCount, "no connection (and so no transaction) is held across the send").toBe(0);
        if (fail.value) throw new Error("resend 503");
        sent.push(message);
      },
    };
    return { sent, sender };
  }

  // ---- AC6 / AC8 ----------------------------------------------------------------------------------------------------

  it("[STORY-068 #8 / AC8] two users, one reads: the notification is still unread for the other", async () => {
    const { id } = await write({ eventKey: "e1", title: "Workspace-wide" });
    expect((await list("owner", "owner")).data.unread_count).toBe(1);
    expect((await list("admin", "admin")).data.unread_count).toBe(1);

    const read = await inTenant(workspaceId, users.owner!, () => service.markRead(viewer("owner", "owner"), id!));
    expect(read).toMatchObject({ id, unread_count: 0 });

    const ownerView = await list("owner", "owner");
    const adminView = await list("admin", "admin");
    expect(ownerView.data.notifications[0]).toMatchObject({ id, read: true });
    expect(ownerView.data.unread_count).toBe(0);
    expect(adminView.data.notifications[0]).toMatchObject({ id, read: false, read_at: null });
    expect(adminView.data.unread_count, "one member reading does not clear it for the team").toBe(1);
  });

  it("[STORY-068 AC8] read-all marks only the caller's inbox, and reading twice is harmless", async () => {
    const a = await write({ eventKey: "a" });
    await write({ eventKey: "b" });
    await inTenant(workspaceId, users.admin!, () => service.markRead(viewer("admin", "admin"), a.id!));
    await inTenant(workspaceId, users.admin!, () => service.markRead(viewer("admin", "admin"), a.id!));
    const all = await inTenant(workspaceId, users.owner!, () => service.markAllRead(viewer("owner", "owner")));
    expect(all).toEqual({ marked: 2, unread_count: 0 });
    expect((await list("admin", "admin")).data.unread_count).toBe(1);
    expect((await list("admin", "admin", null, "true")).data.notifications).toHaveLength(1);
  });

  it("[STORY-068 AC6 / hazard] a user-addressed notification is that user's alone; a project notification reaches only members who may read the project", async () => {
    await write({ eventKey: "u", userId: users.owner!, title: "For the owner" });
    await write({ eventKey: "pb", projectId: projectB, title: "About B" });
    await write({ eventKey: "pa", projectId: projectA, title: "About A" });
    const titles = async (name: string, role: string, scope: string[] | null = null) => (await list(name, role, scope)).data.notifications.map((n) => n.title).sort();
    expect(await titles("owner", "owner")).toEqual(["About A", "About B", "For the owner"]);
    expect(await titles("admin", "admin")).toEqual(["About A", "About B"]);
    expect(await titles("scoped", "manager", [projectA]), "a scoped manager never sees B").toEqual(["About A"]);
    await expect(
      inTenant(workspaceId, users.admin!, async () => service.markRead(viewer("admin", "admin"), (await owner.query("SELECT id FROM notifications WHERE event_key = 'u'")).rows[0].id)),
      "another user's notification is a 404, never readable",
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("[STORY-068 #13 / AC13] the inbox carries each alert's link to the diagnosing surface with its filters applied, and the task it generated", async () => {
    const taskId = randomUUID();
    await write({ eventKey: "dl", projectId: projectA, deepLink: { path: `/p/${projectA}/prompts`, query: { engines: "gemini", tf: "7d" } }, taskId });
    const [n] = (await list("owner", "owner")).data.notifications;
    expect(n).toMatchObject({ deep_link: { path: `/p/${projectA}/prompts`, query: { engines: "gemini", tf: "7d" } }, task_id: taskId, audience: "workspace" });
  });

  it("[STORY-068 hazard] the inbox is cursor-paged, newest first, and the unread count spans every page", async () => {
    for (let i = 0; i < 5; i += 1) await write({ eventKey: `p${String(i)}`, title: `n${String(i)}` });
    const first = await inTenant(workspaceId, users.owner!, () => service.list(viewer("owner", "owner"), { limit: 2, unread: "false" }));
    expect(first.data.notifications).toHaveLength(2);
    expect(first.data.unread_count).toBe(5);
    expect(first.pagination.has_more).toBe(true);
    const second = await inTenant(workspaceId, users.owner!, () => service.list(viewer("owner", "owner"), { limit: 50, unread: "false", cursor: first.pagination.cursor_next! }));
    expect(second.data.notifications).toHaveLength(3);
    expect(new Set([...first.data.notifications, ...second.data.notifications].map((n) => n.id)).size).toBe(5);
  });

  // ---- AC11 / AC12 ---------------------------------------------------------------------------------------------------

  it("[STORY-068 #11 / AC11] the same event key twice writes ONE notification and records its emails once", async () => {
    const enqueued: unknown[] = [];
    const enqueue = async (...args: unknown[]) => void enqueued.push(args);
    const first = await write({ eventKey: "dup", severity: "critical" }, { enqueue });
    const second = await write({ eventKey: "dup", severity: "critical" }, { enqueue });
    expect(first.created).toBe(true);
    expect(second).toEqual({ id: null, created: false, emailIds: [] });
    expect((await owner.query("SELECT count(*)::int AS n FROM notifications WHERE event_key = 'dup'")).rows[0].n).toBe(1);
    await new Promise((resolve) => setImmediate(resolve));
    expect(enqueued).toHaveLength(first.emailIds.length);
  });

  it("[STORY-068 #12 / AC12] a critical notification is emailed at once to every emailable member who may see it; off and default-off members are not", async () => {
    await owner.query("UPDATE workspace_members SET digest_cadence = 'off' WHERE user_id = $1", [users.admin]);
    await owner.query("UPDATE workspace_members SET digest_cadence = 'daily' WHERE user_id = $1", [users.analyst]);
    const outcome = await write({ eventKey: "crit", severity: "critical", projectId: projectB, title: "Urgent" });
    const emails = (await owner.query("SELECT user_id, status, subject FROM notification_emails WHERE kind = 'immediate' ORDER BY user_id")).rows;
    // owner (weekly default) and analyst (opted in); admin opted out; the scoped manager cannot see project B.
    expect(emails.map((e) => e.user_id).sort()).toEqual([users.owner, users.analyst].sort());
    expect(outcome.emailIds).toHaveLength(2);
    expect(emails[0].subject).toContain("Urgent");
  });

  it("[STORY-068 #11 / AC11] a retried dispatch job sends once: a failed send is retried with the SAME provider key, and a job for a sent email sends nothing", async () => {
    const outcome = await write({ eventKey: "retry", severity: "critical", userId: users.owner! });
    const [emailId] = outcome.emailIds;
    const fail = { value: true };
    const { sent, sender } = recordingSender(fail);
    const run = processor(sender);
    const job = jobFor(workspaceId, { kind: "email", emailId: emailId! });
    await expect(run(job), "a failed send fails the job, so the queue retries it").rejects.toThrow("resend 503");
    expect((await owner.query("SELECT status FROM notification_emails WHERE id = $1", [emailId])).rows[0].status).toBe("pending");
    fail.value = false;
    await run(job);
    await run(job);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.idempotencyKey).toBe(`notification-email/${emailId!}`);
    expect(sent[0]!.to).toContain("owner-");
    expect((await owner.query("SELECT status, sent_at FROM notification_emails WHERE id = $1", [emailId])).rows[0]).toMatchObject({ status: "sent" });
  });

  it("[STORY-068 hazard] a dispatch job signed for another workspace cannot send this workspace's email (RLS)", async () => {
    const outcome = await write({ eventKey: "iso", severity: "critical", userId: users.owner! });
    const { sent, sender } = recordingSender();
    await processor(sender)(jobFor(otherWorkspaceId, { kind: "email", emailId: outcome.emailIds[0]! }));
    expect(sent).toHaveLength(0);
  });

  // ---- AC9 / AC10 ----------------------------------------------------------------------------------------------------

  const WEEK_START = "2026-10-12T00:00:00.000Z";
  const WEEK_END = "2026-10-19T00:00:00.000Z";
  async function at(eventKey: string, createdAt: string, extra: Partial<NotificationInput> = {}): Promise<string> {
    const { id } = await write({ eventKey, ...extra });
    await owner.query("UPDATE notifications SET created_at = $2 WHERE id = $1", [id, createdAt]);
    return id!;
  }
  const digestJob = (userId: string, cadence: "daily" | "weekly" = "weekly", start = WEEK_START, end = WEEK_END) =>
    jobFor(workspaceId, { kind: "digest", userId, cadence, periodStart: start, periodEnd: end });

  it("[STORY-068 #9 / AC9] a digest coalesces the period's events into ONE email, and a retried digest job sends nothing more", async () => {
    await at("w1", "2026-10-13T09:00:00Z", { title: "First" });
    await at("w2", "2026-10-15T09:00:00Z", { title: "Second", severity: "info" });
    await at("w3", "2026-10-18T23:59:00Z", { title: "Third" });
    await at("outside", "2026-10-19T00:00:01Z", { title: "Next week" });
    const { sent, sender } = recordingSender();
    const run = processor(sender);
    await run(digestJob(users.owner!));
    await run(digestJob(users.owner!));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toContain("3 updates");
    for (const title of ["First", "Second", "Third"]) expect(sent[0]!.textBody).toContain(title);
    expect(sent[0]!.textBody).not.toContain("Next week");
    const rows = (await owner.query("SELECT kind, cadence, status, notification_count FROM notification_emails WHERE user_id = $1", [users.owner])).rows;
    expect(rows).toEqual([{ kind: "digest", cadence: "weekly", status: "sent", notification_count: 3 }]);
  });

  it("[STORY-068 #10 / AC10] a digest period with no events sends NO email, records that it was skipped, and a retry sends nothing either", async () => {
    await at("old", "2026-10-01T09:00:00Z");
    const { sent, sender } = recordingSender();
    const run = processor(sender);
    await run(digestJob(users.owner!));
    await run(digestJob(users.owner!));
    expect(sent).toHaveLength(0);
    expect((await owner.query("SELECT status, notification_count FROM notification_emails WHERE user_id = $1", [users.owner])).rows).toEqual([
      { status: "skipped_empty", notification_count: 0 },
    ]);
  });

  it("[STORY-068 #10 / AC10] what the member already read, and what was already emailed at once, does not fill a digest", async () => {
    const read = await at("r", "2026-10-13T09:00:00Z");
    await inTenant(workspaceId, users.owner!, () => service.markRead(viewer("owner", "owner"), read));
    const { id: crit } = await write({ eventKey: "c", severity: "critical" });
    await owner.query("UPDATE notifications SET created_at = '2026-10-14T09:00:00Z' WHERE id = $1", [crit]);
    const { sent, sender } = recordingSender();
    await processor(sender)(digestJob(users.owner!));
    expect(sent, "nothing left to say is an empty digest").toHaveLength(0);
  });

  it("[STORY-068 hazard] a digest holds only what that member may see", async () => {
    await at("b", "2026-10-13T09:00:00Z", { projectId: projectB, title: "About B" });
    await at("a", "2026-10-13T10:00:00Z", { projectId: projectA, title: "About A" });
    const { sent, sender } = recordingSender();
    await processor(sender)(digestJob(users.scoped!));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.textBody).toContain("About A");
    expect(sent[0]!.textBody).not.toContain("About B");
  });

  it("[owner 2026-10-23] a member who switched their digest off gets none, even when a job was already queued for them", async () => {
    await at("x", "2026-10-13T09:00:00Z");
    await owner.query("UPDATE workspace_members SET digest_cadence = 'off' WHERE user_id = $1", [users.owner]);
    const { sent, sender } = recordingSender();
    await processor(sender)(digestJob(users.owner!));
    expect(sent).toHaveLength(0);
  });

  it("[owner 2026-10-23 / AC9] the sweep asks for each member's digest at THEIR cadence, once per period, workspace-local: weekly by default for owners, admins and managers", async () => {
    await owner.query("UPDATE workspace_members SET digest_cadence = 'daily' WHERE user_id = $1", [users.admin]);
    // Monday 2026-10-19 09:00 UTC: last week (12..19 Oct) is complete and it is past 08:00 in UTC.
    const now = new Date("2026-10-19T09:00:00Z");
    const targets = await findDigestTargets(owner, now);
    const mine = targets.filter((t) => t.workspaceId === workspaceId).map((t) => [t.userId, t.cadence, t.periodStart, t.periodEnd]);
    expect(mine.sort()).toEqual(
      [
        [users.owner, "weekly", WEEK_START, WEEK_END],
        [users.scoped, "weekly", WEEK_START, WEEK_END],
        [users.admin, "daily", "2026-10-18T00:00:00.000Z", "2026-10-19T00:00:00.000Z"],
      ].sort(),
    );
    // The other workspace is in Asia/Dhaka (UTC+6): its week ended at 2026-10-18T18:00Z.
    expect(targets.filter((t) => t.workspaceId === otherWorkspaceId).map((t) => t.periodEnd)).toEqual(["2026-10-18T18:00:00.000Z"]);

    const enqueued: Array<{ ws: string; payload: NotifyDispatchPayload; key: string }> = [];
    await runNotifySweep(owner, async (_q, ws, payload, options) => void enqueued.push({ ws, payload, key: options.idempotencyKey }), now);
    expect(enqueued.filter((e) => e.payload.kind === "digest")).toHaveLength(4);
    // Once a period's digest is recorded (sent or skipped), the sweep stops asking.
    const { sender } = recordingSender();
    await processor(sender)(digestJob(users.owner!));
    expect((await findDigestTargets(owner, now)).some((t) => t.userId === users.owner)).toBe(false);
  });

  it("[STORY-068 hazard] the sweep relays an email whose job never ran, and nothing younger than its own job's ladder", async () => {
    const outcome = await write({ eventKey: "relay", severity: "critical", userId: users.owner! });
    const enqueued: Array<{ payload: NotifyDispatchPayload; key: string }> = [];
    const enqueue = async (_q: string, _ws: string, payload: NotifyDispatchPayload, options: { idempotencyKey: string }) => void enqueued.push({ payload, key: options.idempotencyKey });
    await runNotifySweep(owner, enqueue, new Date());
    expect(enqueued.filter((e) => e.payload.kind === "email"), "a fresh email's own job may still be running").toHaveLength(0);
    await owner.query("UPDATE notification_emails SET created_at = now() - interval '10 minutes'");
    await runNotifySweep(owner, enqueue, new Date());
    expect(enqueued.filter((e) => e.payload.kind === "email").map((e) => e.payload)).toEqual([{ kind: "email", emailId: outcome.emailIds[0] }]);
  });

  // ---- AC7 -----------------------------------------------------------------------------------------------------------

  it("[STORY-068 #7 / AC7] a quota threshold crossed once notifies once, however many times it is checked again in the cycle", async () => {
    for (let i = 0; i < 5; i += 1) {
      await inTenant(workspaceId, SYSTEM_ACTOR_ID, (tx) => notifyQuotaThresholds(tx, workspaceId, "pdf_exports", "2026-10-01", i === 0 ? [80] : []));
    }
    // A second call that (wrongly) reports the same crossing again is still one notification: the event key holds.
    await inTenant(workspaceId, SYSTEM_ACTOR_ID, (tx) => notifyQuotaThresholds(tx, workspaceId, "pdf_exports", "2026-10-01", [80]));
    await inTenant(workspaceId, SYSTEM_ACTOR_ID, (tx) => notifyQuotaThresholds(tx, workspaceId, "pdf_exports", "2026-10-01", [95]));
    const rows = (await owner.query("SELECT kind, severity, payload FROM notifications ORDER BY created_at")).rows;
    expect(rows.map((r) => [r.kind, r.severity, r.payload.threshold])).toEqual([
      ["usage.quota_threshold", "warning", 80],
      ["usage.quota_threshold", "warning", 95],
    ]);
    expect(rows[0].payload.deep_link).toEqual({ path: "/settings/plan", query: {} });
  });

  it("[STORY-068 #7 / AC7] a credit threshold (25% / 10% of the grant) notifies once per threshold per cycle, stamped on the wallet row, never by a page view", async () => {
    // Growth grants 450 credits a cycle: under 112.5 is below 25%, under 45 is below 10%.
    await owner.query(
      "INSERT INTO credit_wallets (workspace_id, included_balance, purchased_balance, cycle_start, cycle_end) VALUES ($1, 100, 0, '2026-10-01', '2026-11-01')",
      [workspaceId],
    );
    const { sender } = recordingSender();
    const run = processor(sender);
    const check = () => run(jobFor(workspaceId, { kind: "credit_check" }));
    await check();
    await check();
    await check();
    let rows = (await owner.query("SELECT kind, severity, payload FROM notifications ORDER BY created_at")).rows;
    expect(rows.map((r) => [r.kind, r.severity, r.payload.threshold])).toEqual([["credits.threshold", "warning", 25]]);
    expect((await owner.query("SELECT warned_at_25pct IS NOT NULL AS w25, warned_at_10pct IS NULL AS n10 FROM credit_wallets WHERE workspace_id = $1", [workspaceId])).rows[0]).toEqual({ w25: true, n10: true });

    await owner.query("UPDATE credit_wallets SET included_balance = 40 WHERE workspace_id = $1", [workspaceId]);
    await check();
    await check();
    rows = (await owner.query("SELECT kind, severity, payload FROM notifications ORDER BY created_at")).rows;
    expect(rows.map((r) => [r.severity, r.payload.threshold])).toEqual([["warning", 25], ["critical", 10]]);
    // Critical: emailed at once (AC12).
    expect((await owner.query("SELECT count(*)::int AS n FROM notification_emails WHERE kind = 'immediate'")).rows[0].n).toBeGreaterThan(0);

    // A new cycle: the thresholds may fire again, once each.
    await owner.query("UPDATE credit_wallets SET cycle_start = (now() + interval '1 day')::date, cycle_end = (now() + interval '31 days')::date WHERE workspace_id = $1", [workspaceId]);
    await check();
    await check();
    expect((await owner.query("SELECT count(*)::int AS n FROM notifications WHERE kind = 'credits.threshold'")).rows[0].n).toBe(4);
  });
});
