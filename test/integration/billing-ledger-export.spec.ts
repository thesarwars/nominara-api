import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { creditLedgerExportResponseSchema, LEDGER_EXPORT_MAX_ROWS } from "../../contracts/billing/index.js";
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
import { apiUrl } from "../support/api-url.js";
import { useApiHarness } from "../support/api-harness.js";
import { dataOf } from "../support/envelope.js";

// STORY-073 AC10 — GET /billing/wallet/ledger/export. Real ApiModule, real Postgres, requests served as
// `nominara_app` so RLS is in force.

const meta = { ip: "127.0.0.1", ua: "vitest", requestId: randomUUID() };

describe("STORY-073 AC10 · ledger CSV export", () => {
  const harness = useApiHarness({
    env: () => {
      const url = new URL(process.env.DATABASE_URL!);
      url.username = "nominara_app";
      url.password = resolvePassword("nominara_app", {});
      return { DATABASE_URL_POOLED: url.toString() };
    },
  });

  let pool: Pool;
  let sessions: SessionService;
  let workspaces: WorkspacesService;

  beforeEach(async () => {
    vi.restoreAllMocks();
    await harness.db().query(`ALTER ROLE nominara_app PASSWORD '${resolvePassword("nominara_app", {})}'`);
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const membership = new MembershipService(new MembershipCacheService());
    sessions = new SessionService(pool, membership, new InMemoryCacheAdapter());
    workspaces = new WorkspacesService(pool, new LocalDekProvisioner(Buffer.alloc(32, 7), "local:dev"), new AuditChainService(), membership, sessions, new NoopRealtimePublisher());
  });
  afterEach(async () => {
    await pool.end();
  });

  async function createUser(): Promise<string> {
    const r = await harness.db().query<{ id: string }>("INSERT INTO users (email) VALUES ($1) RETURNING id", [`u-${randomUUID()}@example.com`]);
    return r.rows[0]!.id;
  }
  interface Actor {
    readonly accessToken: string;
    readonly csrfToken: string;
    readonly userId: string;
  }
  async function actorIn(workspaceId: string, role: "owner" | "admin" | "manager" | "viewer"): Promise<Actor> {
    const userId = await createUser();
    await harness.db().query("INSERT INTO workspace_members (workspace_id, user_id, role, status) VALUES ($1,$2,$3,'active')", [workspaceId, userId, role]);
    const tokens = await sessions.createSession(userId);
    const entered = await workspaces.switchTo(userId, tokens.sid, workspaceId, meta);
    return { ...entered, userId };
  }
  async function newWorkspace(plan = "growth"): Promise<{ workspaceId: string; owner: Actor }> {
    const ownerId = await createUser();
    const ws = await workspaces.create(ownerId, { name: `Workspace ${randomUUID()}` }, meta);
    if (plan !== "free") await harness.db().query("UPDATE workspaces SET plan_key = $2 WHERE id = $1", [ws.id, plan]);
    const tokens = await sessions.createSession(ownerId);
    const entered = await workspaces.switchTo(ownerId, tokens.sid, ws.id, meta);
    return { workspaceId: ws.id, owner: { ...entered, userId: ownerId } };
  }

  const cookies = (a: Actor) => ({ [ACCESS_COOKIE_NAME]: a.accessToken, [CSRF_COOKIE_NAME]: a.csrfToken });
  const get = (a: Actor, path: string) => harness.app().inject({ method: "GET", url: apiUrl(path), cookies: cookies(a) });
  let n = 0;
  interface Seed {
    readonly workspaceId: string;
    readonly entryType?: "commit" | "adjustment";
    readonly actionCode?: string;
    readonly credits?: number;
    readonly actorId?: string | null;
    readonly reason?: string | null;
    readonly occurredAt?: string;
  }
  async function seed(s: Seed): Promise<void> {
    n += 1;
    const type = s.entryType ?? "commit";
    await harness.db().query(
      `INSERT INTO credit_ledger
         (workspace_id, entry_type, action_code, credits, bucket, included_after, purchased_after, reserved_after,
          actor_id, actor_type, reason, idempotency_key, occurred_at)
       VALUES ($1,$2,$3,$4,$5,100,0,0,$6,$7,$8,$9, COALESCE($10::timestamptz, now()))`,
      [
        s.workspaceId,
        type,
        type === "commit" ? (s.actionCode ?? "manual_scan") : null,
        s.credits ?? 40,
        type === "commit" ? null : "included",
        s.actorId ?? null,
        s.actorId ? "user" : "system",
        s.reason ?? null,
        `export-${String(n)}-${randomUUID().slice(0, 6)}`,
        s.occurredAt ?? null,
      ],
    );
  }

  const exportPath = (qs = "") => `/billing/wallet/ledger/export${qs}`;

  /** Splits the CSV into physical lines. No seeded field contains a newline, so this is sound here. */
  async function csvOf(a: Actor, qs = ""): Promise<{ lines: string[]; meta: { row_count: number; truncated: boolean; filename: string } }> {
    const res = await get(a, exportPath(qs));
    expect(res.statusCode, res.body).toBe(200);
    const body = creditLedgerExportResponseSchema.parse(dataOf(res));
    expect(body.download_url.startsWith("data:text/csv;base64,")).toBe(true);
    const text = Buffer.from(body.download_url.split(",")[1]!, "base64").toString("utf8");
    return { lines: text.split("\r\n").filter((l) => l !== ""), meta: body };
  }

  it("STORY-073 AC10 · exports the caller's rows with the header, newest first, and reports the count", async () => {
    const { workspaceId, owner } = await newWorkspace();
    await seed({ workspaceId, occurredAt: "2026-09-10T10:00:00Z", credits: 11 });
    await seed({ workspaceId, occurredAt: "2026-09-12T10:00:00Z", credits: 22 });
    const { lines, meta } = await csvOf(owner);
    expect(meta.row_count).toBe(2);
    expect(meta.truncated).toBe(false);
    expect(lines[0]).toContain('"occurred_at"');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('"2026-09-12T10:00:00.000Z"');
    expect(lines[2]).toContain('"2026-09-10T10:00:00.000Z"');
  });

  it("STORY-073 AC10 · an empty ledger exports the header alone with row_count 0", async () => {
    const { owner } = await newWorkspace();
    const { lines, meta } = await csvOf(owner);
    expect(meta.row_count).toBe(0);
    expect(lines).toHaveLength(1);
  });

  it("STORY-073 AC10 · cross-workspace rows are NEVER present", async () => {
    const a = await newWorkspace();
    const b = await newWorkspace();
    await seed({ workspaceId: a.workspaceId, reason: null });
    await seed({ workspaceId: b.workspaceId, entryType: "adjustment", credits: -5, reason: "other-tenant-secret" });
    const { lines, meta } = await csvOf(a.owner);
    expect(meta.row_count).toBe(1);
    expect(lines.join("\n")).not.toContain("other-tenant-secret");
    expect(lines.join("\n")).not.toContain(b.workspaceId);
  });

  it("STORY-073 AC10 · the export takes the ledger's filters: action, entry_type, actor, and the whole of the `to` day", async () => {
    const { workspaceId, owner } = await newWorkspace();
    const actorId = await createUser();
    await seed({ workspaceId, actionCode: "lookup", occurredAt: "2026-09-10T10:00:00Z" });
    await seed({ workspaceId, actionCode: "manual_scan", occurredAt: "2026-09-12T23:30:00Z", actorId });
    await seed({ workspaceId, entryType: "adjustment", credits: -3, reason: "fix", occurredAt: "2026-09-14T10:00:00Z" });
    expect((await csvOf(owner, "?action=lookup")).meta.row_count).toBe(1);
    expect((await csvOf(owner, "?entry_type=adjustment")).meta.row_count).toBe(1);
    expect((await csvOf(owner, `?actor_id=${actorId}`)).meta.row_count).toBe(1);
    expect((await csvOf(owner, "?to=2026-09-12")).meta.row_count).toBe(2);
    expect((await csvOf(owner, "?from=2026-09-12&to=2026-09-12")).meta.row_count).toBe(1);
    expect((await csvOf(owner, "?action=lookup&entry_type=adjustment")).meta.row_count).toBe(0);
  });

  it("STORY-073 AC10 · an unknown filter, a cursor or a limit is a 400, never a wider file", async () => {
    const { owner } = await newWorkspace();
    for (const qs of ["?actor=x", "?cursor=abc", "?limit=5"]) {
      expect((await get(owner, exportPath(qs))).statusCode, qs).toBe(400);
    }
  });

  it("STORY-073 AC10 · billing:read is enforced: a viewer and a manager are 403 naming it", async () => {
    const { workspaceId } = await newWorkspace();
    for (const role of ["viewer", "manager"] as const) {
      const res = await get(await actorIn(workspaceId, role), exportPath());
      expect(res.statusCode).toBe(403);
      expect(res.body).toContain("billing:read");
    }
    expect((await get(await actorIn(workspaceId, "admin"), exportPath())).statusCode).toBe(200);
  });

  it("STORY-073 AC10 · exports.csv is enforced: a Starter workspace is 403 feature_not_in_plan", async () => {
    const { workspaceId, owner } = await newWorkspace("starter");
    await seed({ workspaceId });
    const res = await get(owner, exportPath());
    expect(res.statusCode).toBe(403);
    const error = res.json<{ error: { code: string; details?: { key?: string } } }>().error;
    expect(error.code).toBe("feature_not_in_plan");
    expect(error.details?.key).toBe("exports.csv");
  });

  it("STORY-073 AC10 · a text cell starting with =, +, - or @ is defused; a negative credits cell is left numeric", async () => {
    const { workspaceId, owner } = await newWorkspace();
    const actorId = await createUser();
    for (const reason of ["=HYPERLINK(\"http://x\")", "+1+1", "-2+3", "@SUM(A1)"]) {
      await seed({ workspaceId, entryType: "adjustment", credits: -7, reason, actorId });
    }
    const { lines } = await csvOf(owner);
    const text = lines.slice(1).join("\n");
    for (const dangerous of ["=HYPERLINK", "+1+1", "-2+3", "@SUM"]) {
      expect(text).toContain(`"\t${dangerous}`);
      expect(text).not.toContain(`,"${dangerous}`);
    }
    expect(text).toContain('"-7"');
    expect(text).not.toContain('"\t-7"');
  });

  it("STORY-073 AC10 · the file is bounded: past the cap it holds the newest rows and says truncated", async () => {
    const { workspaceId, owner } = await newWorkspace();
    await harness.db().query(
      `INSERT INTO credit_ledger
         (workspace_id, entry_type, action_code, credits, included_after, purchased_after, reserved_after, actor_type, idempotency_key, occurred_at)
       SELECT $1, 'commit', 'manual_scan', 1, 100, 0, 0, 'system', 'bulk-' || g, now() - make_interval(secs => g)
         FROM generate_series(1, $2::int) g`,
      [workspaceId, LEDGER_EXPORT_MAX_ROWS + 1],
    );
    const { meta, lines } = await csvOf(owner);
    expect(meta.truncated).toBe(true);
    expect(meta.row_count).toBe(LEDGER_EXPORT_MAX_ROWS);
    expect(lines).toHaveLength(LEDGER_EXPORT_MAX_ROWS + 1);
  });
});
