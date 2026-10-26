import { createHash, randomUUID } from "node:crypto";
import { OPEN_ENGINE_GATE } from "./open-engine-gate.js";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { Job } from "bullmq";
import { Client } from "pg";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { InMemoryCacheAdapter } from "../../src/lib/cache/in-memory-cache.adapter.js";
import type { RealtimePublisher } from "../../src/lib/cache/realtime-publisher.js";
import { provisionWalletWithGrant } from "../../src/lib/credits/balance.js";
import { appendLedgerEntry } from "../../src/lib/credits/ledger.js";
import { commitCredits, reserveCredits } from "../../src/lib/credits/wallet.js";
import type { SpendMeter } from "../../src/lib/engines/spend-meter.js";
import { createCaptureExecuteHandler } from "../../src/lib/queue/handlers/capture-execute.handler.js";
import type { QueueHandlerContext } from "../../src/lib/queue/handlers.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";

// SCANFIX - the shared fixture for the specs that race a capture cell against the stuck-run
// reaper and against a second finalisation. Several connections to one real Postgres, because
// the hazards are Postgres row-lock semantics that one connection cannot show.

export const CHARGE = 500;
export const HOUR_MS = 60 * 60 * 1000;

export interface Tenant {
  readonly ws: string;
  readonly project: string;
  readonly user: string;
}

export interface Emitted {
  readonly event: string;
  readonly payload: Record<string, unknown>;
}

export interface RaceDb {
  readonly container: StartedPostgreSqlContainer;
  /** The connection fixtures are written on, and the handler's transaction runs on. */
  readonly db: Client;
  readonly connect: () => Promise<Client>;
  readonly stop: () => Promise<void>;
}

export async function startRaceDb(): Promise<RaceDb> {
  const container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
    .withDatabase("nominara_test")
    .withUsername("nominara")
    .withPassword("nominara")
    .start();
  const open = async (): Promise<Client> => {
    const client = new Client({ connectionString: container.getConnectionUri() });
    await client.connect();
    return client;
  };
  const db = await open();
  await migrateUp(db);
  const extra: Client[] = [];
  return {
    container,
    db,
    connect: async () => {
      const client = await open();
      extra.push(client);
      return client;
    },
    stop: async () => {
      await Promise.all(extra.map((c) => c.end().catch(() => undefined)));
      await db.end();
      await container.stop();
    },
  };
}

export async function truncateAll(db: Client): Promise<void> {
  await db.query("TRUNCATE answer_captures, tracked_prompts, capture_runs, projects, credit_ledger, credit_wallets, workspaces, users RESTART IDENTITY CASCADE");
}

export async function addTenant(db: Client): Promise<Tenant> {
  const ws = randomUUID();
  const project = randomUUID();
  await db.query("INSERT INTO workspaces (id, name, slug, plan_key, timezone) VALUES ($1,'Secret Co Name',$2,'growth','UTC')", [ws, `w-${randomUUID().slice(0, 8)}`]);
  const user = (await db.query<{ id: string }>("INSERT INTO users (email) VALUES ($1) RETURNING id", [`a-${randomUUID().slice(0, 8)}@nominara.test`])).rows[0]!.id;
  await db.query("INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain) VALUES ($1,$2,'P',$3,'https://e.test','e.test')", [project, ws, `p-${randomUUID().slice(0, 8)}`]);
  return { ws, project, user };
}

export async function addPrompt(db: Client, t: Tenant, text = "q"): Promise<string> {
  const id = randomUUID();
  const unique = `${text} ${id}`;
  await db.query(
    `INSERT INTO tracked_prompts (id, workspace_id, project_id, text, text_hash, intent_archetype, funnel_stage, is_priority, status)
     VALUES ($1,$2,$3,$4,sha256($5::bytea),'recommendation','consideration',false,'active')`,
    [id, t.ws, t.project, unique, Buffer.from(unique)],
  );
  return id;
}

/** A run that was last touched `ageHours` ago. A terminal status carries the finish time its CHECK wants. */
export async function addRun(db: Client, t: Tenant, o: { ageHours?: number; planned: number; status?: string; trigger?: string }): Promise<string> {
  const id = randomUUID();
  const status = o.status ?? "running";
  const age = String(o.ageHours ?? 0);
  await db.query(
    `INSERT INTO capture_runs (id, workspace_id, project_id, trigger, engine_keys, planned_cells, status, created_at, started_at, finished_at)
     VALUES ($1,$2,$3,$4,ARRAY['gemini'],$5,$6, now() - ($7 || ' hours')::interval,
             CASE WHEN $6 <> 'queued' THEN now() - ($7 || ' hours')::interval END,
             CASE WHEN $6 IN ('completed','partial','failed','canceled') THEN now() - ($7 || ' hours')::interval END)`,
    [id, t.ws, t.project, o.trigger ?? "manual", o.planned, status, age],
  );
  return id;
}

export async function addCapture(db: Client, t: Tenant, runId: string, promptId: string, o: { ageHours?: number; status?: string; sampleIndex: number }): Promise<void> {
  await db.query(
    `INSERT INTO answer_captures
       (id, workspace_id, project_id, run_id, prompt_id, engine_key, captured_at, capture_mode, adapter_version,
        normalizer_version, content_hash, flags, cache_layer, status, sample_index)
     VALUES ($1,$2,$3,$4,$5,'gemini', now() - ($6 || ' hours')::interval,'api','1.0.0','n1',$7,'{}','live',$8,$9)`,
    [randomUUID(), t.ws, t.project, runId, promptId, String(o.ageHours ?? 0), createHash("sha256").update(randomUUID()).digest(), o.status ?? "parsed", o.sampleIndex],
  );
}

/** The run was charged up front, exactly as the guard and interceptor leave it. */
export async function chargeRun(db: Client, t: Tenant, runId: string): Promise<void> {
  await db.query("BEGIN");
  await provisionWalletWithGrant(db, t.ws, 1_000, { start: "2026-09-01", end: "2026-10-01" });
  const reserved = await reserveCredits(db, t.ws, CHARGE);
  await appendLedgerEntry(db, { workspaceId: t.ws, entryType: "reserve", actionCode: "manual_scan", credits: CHARGE, idempotencyKey: `deep-${runId}`, attempt: 1, after: reserved.wallet!, actorId: t.user, actorType: "user" });
  const committed = await commitCredits(db, t.ws, CHARGE, CHARGE);
  await appendLedgerEntry(db, { workspaceId: t.ws, entryType: "commit", actionCode: "manual_scan", credits: CHARGE, idempotencyKey: `deep-${runId}`, attempt: 1, after: committed!, actorId: t.user, actorType: "user", referenceType: "run", referenceId: runId });
  await db.query("COMMIT");
}

export function jobFor(t: Tenant, runId: string, promptId: string, text: string, o: { sampleIndex?: number; final?: boolean } = {}): Job {
  return {
    attemptsMade: o.final === true ? 4 : 0,
    opts: { attempts: 5 },
    data: {
      payload: { workspaceId: t.ws, kid: "k", projectId: t.project, runId, promptId, promptText: text, engineKey: "gemini", sampleIndex: o.sampleIndex ?? 0, adapterVersion: "1.0.0", ttlSeconds: 3600, locale: "en-US", personaHint: null },
    },
  } as unknown as Job;
}

/** Runs the REAL capture.execute handler in its own tenant transaction on `client`. */
export function executeOn(client: Client, t: Tenant, job: Job, emitted: Emitted[], rollups: unknown[] = []): Promise<void> {
  const publisher: RealtimePublisher = {
    toWorkspace: (_ws, event, payload) => {
      emitted.push({ event, payload: payload as Record<string, unknown> });
    },
    toProject: (_ws, _project, event, payload) => {
      emitted.push({ event, payload: payload as Record<string, unknown> });
    },
    memberChanged: () => undefined,
  };
  const handler = createCaptureExecuteHandler({ pool: undefined, env: {} } as unknown as QueueHandlerContext, {
    cache: new InMemoryCacheAdapter(),
    engineGate: OPEN_ENGINE_GATE,
    realtime: publisher,
    enqueueParse: () => Promise.resolve(),
    spendMeter: { isCeilingReached: () => Promise.resolve(false), recordCost: () => Promise.resolve({ newAlerts: [], totalUsd: 0, ceilingUsd: 100, hardStopped: false }) } as unknown as SpendMeter,
    enqueueRollup: (queue, _ws, payload, idempotencyKey) => {
      rollups.push({ queue, payload, idempotencyKey });
      return Promise.resolve();
    },
  });
  return withTenantContext(client, { workspaceId: t.ws, actorId: SYSTEM_ACTOR_ID }, async (tx) => {
    await handler(tx, job);
  });
}

export async function runRow(db: Client, id: string) {
  return (await db.query<{ status: string; finished_at: Date | null; captured_cells: number; failed_cells: number }>("SELECT status, finished_at, captured_cells, failed_cells FROM capture_runs WHERE id = $1", [id])).rows[0]!;
}

export async function refundsFor(db: Client, ws: string): Promise<number[]> {
  return (await db.query<{ credits: string }>("SELECT credits::text FROM credit_ledger WHERE workspace_id = $1 AND entry_type = 'refund' ORDER BY seq", [ws])).rows.map((r) => Number(r.credits));
}

export async function captureCount(db: Client, runId: string): Promise<number> {
  return Number((await db.query<{ n: string }>("SELECT count(*)::text AS n FROM answer_captures WHERE run_id = $1", [runId])).rows[0]!.n);
}

/** Resolves true once some backend is waiting on a lock, false if `settled()` flips first or the deadline passes. */
export async function someoneWaitsOnALock(probe: Client, settled: () => boolean, timeoutMs = 4_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !settled()) {
    const waiting = await probe.query<{ n: string }>("SELECT count(*)::text AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()");
    if (Number(waiting.rows[0]!.n) > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

export function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
