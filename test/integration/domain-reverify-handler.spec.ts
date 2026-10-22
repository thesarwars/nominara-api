import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Logger } from "@nestjs/common";
import { trace } from "@opentelemetry/api";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { Job } from "bullmq";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { handlerFor, type QueueHandlerContext } from "../../src/lib/queue/handlers.js";
import { createDomainReverifyHandler, MIN_RECHECK_INTERVAL_MS } from "../../src/lib/queue/handlers/domain-reverify.handler.js";
import { globalQueueLockKey, tryAdvisorySessionLock } from "../../src/lib/queue/locks.js";
import { GuardedFetchRefusal } from "../../src/lib/net/guarded-fetch.js";
import { TXT_PREFIX, type CheckDeps } from "../../src/lib/verification/checkers.js";
import { applyCheckOutcome, INCONCLUSIVE_GRACE_MS, type VerificationRow } from "../../src/lib/verification/transition.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import type { Env } from "../../src/config/env.schema.js";

// STORY-048 AC7 — the PERIODIC half. `domain.reverify` is the daily tick that re-checks every verified domain, so a
// domain that stops verifying loses full scope WITH a notification instead of silently continuing at full scope.
//
// The discovery read is cross-tenant (the owner connection, as identity.sweep_unverified); every state change is applied
// in ONE tenant's context as the runtime role `nominara_app`, so RLS is live for the write and a loss in workspace A can
// only ever touch A. The superuser would bypass RLS and make the isolation test vacuous.

const counters: { name: string; labels: Record<string, string> }[] = [];
vi.mock("../../src/lib/telemetry/metrics.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/telemetry/metrics.js")>("../../src/lib/telemetry/metrics.js");
  return {
    ...actual,
    incrementCounter: (name: string, labels: Record<string, string> = {}) => {
      counters.push({ name, labels });
      actual.incrementCounter(name, labels);
    },
  };
});

const HOUR = 60 * 60 * 1000;
const NOW = new Date("2026-10-20T02:20:00Z");
const tick = (): Job => ({ data: {} }) as unknown as Job;

describe("STORY-048 AC7 · domain.reverify (periodic re-verification)", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let pool: Pool;
  let env: Env;
  /** domain -> TXT values currently published. */
  let published: Record<string, string[]>;
  let resolveCalls: string[];
  let openTxDuringCheck: number[];
  const exporter = new InMemorySpanExporter();

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test").withUsername("nominara").withPassword("nominara").start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await migrateUp(db);
    const password = resolvePassword("nominara_app", {});
    await db.query(`ALTER ROLE nominara_app PASSWORD ${db.escapeLiteral(password)}`);
    pool = new Pool({
      host: container.getHost(),
      port: container.getMappedPort(5432),
      database: container.getDatabase(),
      user: "nominara_app",
      password,
    });
    env = { DATABASE_URL: container.getConnectionUri() } as unknown as Env;
    trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }));
  }, 300_000);

  afterAll(async () => {
    await pool.end();
    await db.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.query("DROP TRIGGER IF EXISTS poison_notifications ON notifications");
    await db.query("TRUNCATE workspaces CASCADE");
    counters.length = 0;
    exporter.reset();
    published = {};
    resolverFails = {};
    resolveCalls = [];
    openTxDuringCheck = [];
  });

  const checks = (): CheckDeps => ({
    resolveTxt: async (name: string) => {
      resolveCalls.push(name);
      // The network wait must never sit inside a transaction (KAD-06): nothing may be `idle in transaction` now.
      const open = await db.query<{ n: string }>(
        "SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND state LIKE 'idle in transaction%' AND pid <> pg_backend_pid()",
      );
      openTxDuringCheck.push(Number(open.rows[0]!.n));
      const domain = name.replace(/^_nominara-verify\./, "");
      const failure = resolverFails[domain];
      if (failure !== undefined) throw Object.assign(new Error(failure), { code: failure });
      const values = published[domain];
      if (values === undefined) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
      return values.map((value) => [value]);
    },
    fetch: async () => {
      throw new Error("no http in this spec");
    },
  });

  /** domain -> an error code the resolver throws instead of answering (our-side failure). */
  let resolverFails: Record<string, string>;
  const run = async (overrides: Partial<Parameters<typeof createDomainReverifyHandler>[1]> = {}): Promise<unknown> => {
    const context = { pool, env } as unknown as QueueHandlerContext;
    return createDomainReverifyHandler(context, { checks: checks(), now: () => NOW, ...overrides })(db, tick());
  };

  interface Seeded { ws: string; project: string; nonce: string; domain: string }
  async function seed(
    slug: string,
    options: { verified?: boolean; lastCheckedHoursAgo?: number | null; method?: string; deleted?: boolean; projectDomain?: string } = {},
  ): Promise<Seeded> {
    const domain = `${slug}.example.com`;
    const nonce = `nonce-${slug}`;
    const ws = (await db.query("INSERT INTO workspaces (name, slug, plan_key) VALUES ($1,$2,'free') RETURNING id", [`W ${slug}`, `w-${slug}`])).rows[0].id as string;
    const verifiedAt = options.verified === false ? null : new Date(NOW.getTime() - 3 * 24 * HOUR);
    const project = (await db.query(
      `INSERT INTO projects (workspace_id, name, slug, root_url, root_domain, domain_verified_at, deleted_at)
       VALUES ($1,'P',$2,$3,$4,$5,$6) RETURNING id`,
      [ws, `p-${slug}`, `https://${domain}`, options.projectDomain ?? domain, verifiedAt, options.deleted ? NOW : null],
    )).rows[0].id as string;
    await addMethod({ ws, project, nonce, domain }, options.method ?? "dns_txt", verifiedAt, options.lastCheckedHoursAgo === undefined ? 30 : options.lastCheckedHoursAgo);
    return { ws, project, nonce, domain };
  }
  async function addMethod(s: Seeded, method: string, verifiedAt: Date | null, lastCheckedHoursAgo: number | null): Promise<void> {
    await db.query(
      `INSERT INTO domain_verifications (id, workspace_id, project_id, domain, method, nonce, verified_at, last_checked_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [randomUUID(), s.ws, s.project, s.domain, method, `${s.nonce}-${method}`, verifiedAt,
        lastCheckedHoursAgo === null ? null : new Date(NOW.getTime() - lastCheckedHoursAgo * HOUR)],
    );
  }
  const publish = (s: Seeded, method = "dns_txt"): void => {
    published[s.domain] = [`${TXT_PREFIX}${s.nonce}${method === "dns_txt" ? "-dns_txt" : ""}`];
  };
  const verification = async (s: Seeded, method = "dns_txt") =>
    (await db.query("SELECT verified_at, last_checked_at, failure_reason FROM domain_verifications WHERE project_id=$1 AND method=$2", [s.project, method])).rows[0];
  const mirror = async (s: Seeded) => (await db.query("SELECT domain_verified_at FROM projects WHERE id=$1", [s.project])).rows[0].domain_verified_at as Date | null;
  const notifications = async (s: Seeded) =>
    (await db.query("SELECT kind, severity, payload FROM notifications WHERE workspace_id=$1", [s.ws])).rows;
  const auditRows = async (s: Seeded) =>
    (await db.query("SELECT action, actor_type, resource_type, resource_id, severity FROM audit_log WHERE workspace_id=$1 ORDER BY seq", [s.ws])).rows;

  it("is registered for its queue, so the worker has something to run", () => {
    expect(handlerFor("domain.reverify")).toBeDefined();
  });

  it("AC7 / scenario 10 · a verified domain whose record is gone loses scope: cleared, mirrored, notified once, audited", async () => {
    const lost = await seed("lost");
    await run(); // nothing published for the domain

    const row = await verification(lost);
    expect(row.verified_at).toBeNull();
    expect(row.failure_reason).toBe("record_absent");
    expect(await mirror(lost)).toBeNull();
    const notes = await notifications(lost);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ kind: "domain.verification_lost", severity: "warning" });
    // the worker-initiated change writes its OWN audit row (AC10): no controller @Audit exists on this path
    const audit = await auditRows(lost);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: "project.domain_verification_lost",
      actor_type: "system",
      resource_type: "project",
      resource_id: lost.project,
    });
  });

  it("AC7 · a redelivered or repeated run does not notify or audit twice", async () => {
    const lost = await seed("twice");
    await run();
    await run();
    expect(await notifications(lost)).toHaveLength(1);
    expect(await auditRows(lost)).toHaveLength(1);
  });

  it("AC7 · a domain that still verifies stays verified, records the attempt, and says nothing", async () => {
    const fine = await seed("fine");
    publish(fine);
    const result = await run();

    const row = await verification(fine);
    expect(row.verified_at).not.toBeNull();
    expect(row.failure_reason).toBeNull();
    expect(new Date(row.last_checked_at).getTime()).toBe(NOW.getTime());
    expect(await mirror(fine)).not.toBeNull();
    expect(await notifications(fine)).toHaveLength(0);
    expect(await auditRows(fine)).toHaveLength(0);
    expect(result).toMatchObject({ status: "complete", checked: 1, lost: 0, failed: 0 });
  });

  it("AC7 · losing ONE of two methods keeps full scope: audited, but NO false 'scope lost' notification", async () => {
    const both = await seed("both");
    await addMethod(both, "well_known_file", new Date(NOW.getTime() - 3 * 24 * HOUR), 30);
    // dns record is gone (nothing published); the file method needs http, which this spec's fetch refuses -> that one fails too,
    // so make the file method un-checkable-by-staleness instead: it was checked 1h ago and is NOT due.
    await db.query("UPDATE domain_verifications SET last_checked_at = $2 WHERE project_id = $1 AND method = 'well_known_file'", [
      both.project, new Date(NOW.getTime() - 1 * HOUR),
    ]);
    await run();

    expect((await verification(both, "dns_txt")).verified_at).toBeNull();
    expect((await verification(both, "well_known_file")).verified_at).not.toBeNull();
    expect(await mirror(both)).not.toBeNull();
    expect(await notifications(both)).toHaveLength(0);
    const audit = await auditRows(both);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.action).toBe("project.domain_verification_lost");
  });

  it("AC7 · never checks a method that was never verified (nothing to lose, and no fetch is spent on it)", async () => {
    await seed("pending", { verified: false, lastCheckedHoursAgo: null });
    await run();
    expect(resolveCalls).toEqual([]);
  });

  it("AC7 · does not re-check a domain checked inside the minimum interval, and does once it is older", async () => {
    await seed("recent", { lastCheckedHoursAgo: 1 });
    await run();
    expect(resolveCalls).toEqual([]);
    await db.query("UPDATE domain_verifications SET last_checked_at = $1", [new Date(NOW.getTime() - MIN_RECHECK_INTERVAL_MS - 1000)]);
    await run();
    expect(resolveCalls).toHaveLength(1);
  });

  it("AC7 · skips a soft-deleted project and a verification for a domain the project no longer has", async () => {
    await seed("deleted", { deleted: true });
    await seed("moved", { projectDomain: "somewhere-else.example.com" });
    await run();
    expect(resolveCalls).toEqual([]);
  });

  it("AC7 · a batch is bounded, oldest-checked first, and the remainder is picked up by the next run", async () => {
    const oldest = await seed("b1", { lastCheckedHoursAgo: 90 });
    const middle = await seed("b2", { lastCheckedHoursAgo: 60 });
    const newest = await seed("b3", { lastCheckedHoursAgo: 30 });
    for (const s of [oldest, middle, newest]) publish(s);

    const first = await run({ batchSize: 2 });
    expect(first).toMatchObject({ checked: 2 });
    expect(resolveCalls.sort()).toEqual([`_nominara-verify.${oldest.domain}`, `_nominara-verify.${middle.domain}`].sort());
    const second = await run({ batchSize: 2 });
    expect(second).toMatchObject({ checked: 1 });
    expect(resolveCalls).toContain(`_nominara-verify.${newest.domain}`);
  });

  it("NFR-SEC-01 · a loss in workspace A touches A alone; B's verified domain, mirror and inbox are untouched", async () => {
    const a = await seed("tenant-a");
    const b = await seed("tenant-b");
    publish(b);
    await run();

    expect(await mirror(a)).toBeNull();
    expect(await notifications(a)).toHaveLength(1);
    expect(await mirror(b)).not.toBeNull();
    expect(await notifications(b)).toHaveLength(0);
    expect(await auditRows(b)).toHaveLength(0);
    // every notification and audit row carries the workspace it was written for
    const stray = await db.query("SELECT 1 FROM notifications n JOIN projects p ON p.id = n.project_id WHERE p.workspace_id <> n.workspace_id");
    expect(stray.rows).toHaveLength(0);
  });

  it.each(["ETIMEOUT", "ESERVFAIL"])("AC7 · a resolver %s is OUR outage: scope kept, no notification, no audit row, the next run re-checks", async (code) => {
    const s = await seed("outage");
    resolverFails[s.domain] = code;
    const first = await run();

    const row = await verification(s);
    expect(row.verified_at).not.toBeNull();
    expect(new Date(row.last_checked_at).getTime()).toBe(NOW.getTime());
    expect(await mirror(s)).not.toBeNull();
    expect(await notifications(s)).toHaveLength(0);
    expect(await auditRows(s)).toHaveLength(0);
    expect(first).toMatchObject({ status: "complete", checked: 1, lost: 0, failed: 0 });
    expect(counters.some((c) => c.name === "nominara_domain_reverify_checked_total" && c.labels.outcome === "inconclusive")).toBe(true);

    // inside the interval nothing re-checks; once the interval passes the same domain is checked again, and this time the record is gone
    delete resolverFails[s.domain];
    await run();
    expect(resolveCalls).toHaveLength(1);
    const later = new Date(NOW.getTime() + MIN_RECHECK_INTERVAL_MS + 1000);
    await run({ now: () => later });
    expect(resolveCalls).toHaveLength(2);
    expect((await verification(s)).verified_at).toBeNull();
    expect(await notifications(s)).toHaveLength(1);
  });

  it("review r2 · a FILE-verified domain survives a resolver outage in the guarded fetcher: scope kept, nothing sent", async () => {
    const s = await seed("file-outage", { method: "well_known_file" });
    const outage: CheckDeps = {
      ...checks(),
      fetch: async () => {
        throw new GuardedFetchRefusal("dns_resolution_failed", "EAI_AGAIN");
      },
    };
    const result = await run({ checks: outage });

    expect((await verification(s, "well_known_file")).verified_at).not.toBeNull();
    expect(await mirror(s)).not.toBeNull();
    expect(await notifications(s)).toHaveLength(0);
    expect(await auditRows(s)).toHaveLength(0);
    expect(result).toMatchObject({ checked: 1, lost: 0, inconclusive: 1 });
  });

  it("review r2 · a name that does NOT exist (ENOTFOUND in the guarded fetcher) is conclusive: the file method is lost", async () => {
    const s = await seed("file-gone", { method: "well_known_file" });
    const gone: CheckDeps = {
      ...checks(),
      fetch: async () => {
        throw new GuardedFetchRefusal("dns_resolution_failed", "ENOTFOUND");
      },
    };
    await run({ checks: gone });
    expect((await verification(s, "well_known_file")).verified_at).toBeNull();
    expect(await notifications(s)).toHaveLength(1);
  });

  it("review r2 · a MANUAL re-check that is inconclusive keeps verified_at and notifies nobody (same rule as the sweep)", async () => {
    const s = await seed("manual-outage");
    const row = (await db.query("SELECT id, domain, method, nonce, verified_at, last_checked_at, failure_reason FROM domain_verifications WHERE project_id=$1", [s.project])).rows[0] as VerificationRow;
    const client = await pool.connect();
    try {
      const applied = await withTenantContext(client, { workspaceId: s.ws, actorId: SYSTEM_ACTOR_ID }, (tx) =>
        applyCheckOutcome(tx, {
          workspaceId: s.ws, projectId: s.project, domain: s.domain, row,
          outcome: { ok: false, reason: "record_absent", inconclusive: true }, now: NOW,
        }),
      );
      expect(applied).toMatchObject({ methodLost: false, scopeLost: false });
    } finally {
      client.release();
    }
    const after = await verification(s);
    expect(after.verified_at).not.toBeNull();
    expect(after.failure_reason).toBe("record_absent");
    expect(await mirror(s)).not.toBeNull();
    expect(await notifications(s)).toHaveLength(0);
  });

  it("review r2 · the sweep writes the time of ITS check, not the run's start (a manual check in between is never moved backwards past)", async () => {
    const s = await seed("clock");
    publish(s);
    const checkAt = new Date(NOW.getTime() + 30 * 60 * 1000);
    let calls = 0;
    await run({ now: () => (calls++ === 0 ? NOW : checkAt) }); // the first reading is the run start; later ones are the chunk's check
    expect(new Date((await verification(s)).last_checked_at).getTime()).toBe(checkAt.getTime());
  });

  it("review r2 · two losses on DIFFERENT methods of one project, interleaved, still leave the mirror cleared and notify once", async () => {
    const s = await seed("two-methods");
    await addMethod(s, "well_known_file", new Date(NOW.getTime() - 3 * 24 * HOUR), 30);
    const rowOf = async (method: string) =>
      (await db.query("SELECT id, domain, method, nonce, verified_at, last_checked_at, failure_reason FROM domain_verifications WHERE project_id=$1 AND method=$2", [s.project, method])).rows[0] as VerificationRow;
    const [dns, file] = [await rowOf("dns_txt"), await rowOf("well_known_file")];
    const lose = (row: VerificationRow) => async (tx: Parameters<Parameters<typeof withTenantContext>[2]>[0]) =>
      applyCheckOutcome(tx, { workspaceId: s.ws, projectId: s.project, domain: s.domain, row, outcome: { ok: false, reason: "record_absent" }, now: NOW });

    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const c1 = await pool.connect();
    const c2 = await pool.connect();
    try {
      // T1 applies its loss and then HOLDS its transaction open; T2 starts while it is held.
      const first = withTenantContext(c1, { workspaceId: s.ws, actorId: SYSTEM_ACTOR_ID }, async (tx) => {
        const applied = await lose(dns)(tx);
        await gate;
        return applied;
      });
      await new Promise((resolve) => setTimeout(resolve, 150));
      const second = withTenantContext(c2, { workspaceId: s.ws, actorId: SYSTEM_ACTOR_ID }, lose(file));
      await new Promise((resolve) => setTimeout(resolve, 300));
      release();
      const [a, b] = await Promise.all([first, second]);
      expect([a.scopeLost, b.scopeLost].filter(Boolean)).toHaveLength(1);
    } finally {
      release();
      c1.release();
      c2.release();
    }
    expect(await mirror(s)).toBeNull();
    expect(await notifications(s)).toHaveLength(1);
  });

  it("AC7 · an outcome computed before a newer manual check committed is discarded, not applied on stale evidence", async () => {
    const s = await seed("stale");
    // the manual check lands WHILE the sweep's check is in flight: it fails the domain at a time after the sweep began
    const manualAt = new Date(NOW.getTime() + 5 * 60 * 1000);
    const base = checks();
    const interleaved: CheckDeps = {
      ...base,
      resolveTxt: async () => {
        await db.query(
          "UPDATE domain_verifications SET verified_at = NULL, last_checked_at = $2, failure_reason = 'record_absent' WHERE project_id = $1",
          [s.project, manualAt],
        );
        return [[`${TXT_PREFIX}${s.nonce}-dns_txt`]]; // the sweep saw a good record at T0
      },
    };
    await run({ checks: interleaved });
    const row = await verification(s);
    expect(row.verified_at).toBeNull(); // not re-verified on the older evidence
    expect(new Date(row.last_checked_at).getTime()).toBe(manualAt.getTime());
  });

  it("NFR-SEC-01 · the write runs as nominara_app inside the row's own workspace context, not on the owner connection", async () => {
    const a = await seed("rls-a");
    await db.query("CREATE TABLE write_sessions (tbl text, usr text, ws text)");
    await db.query(`CREATE FUNCTION note_session() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
      BEGIN INSERT INTO write_sessions VALUES (TG_TABLE_NAME, session_user, current_setting('app.current_workspace_id', true)); RETURN NEW; END $$`);
    await db.query("CREATE TRIGGER note_dv BEFORE UPDATE ON domain_verifications FOR EACH ROW EXECUTE FUNCTION note_session()");
    await db.query("CREATE TRIGGER note_pr BEFORE UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION note_session()");
    try {
      await run();
      const rows = (await db.query("SELECT tbl, usr, ws FROM write_sessions")).rows;
      expect(rows.length).toBeGreaterThanOrEqual(2);
      for (const r of rows) {
        expect(r.usr).toBe("nominara_app");
        expect(r.ws).toBe(a.ws);
      }
    } finally {
      await db.query("DROP TRIGGER note_dv ON domain_verifications");
      await db.query("DROP TRIGGER note_pr ON projects");
      await db.query("DROP FUNCTION note_session()");
      await db.query("DROP TABLE write_sessions");
    }
  });

  it("AC7 · a manual check holding a STALE row cannot notify a loss the sweep already recorded", async () => {
    const s = await seed("raced");
    const stale = (await db.query("SELECT id, domain, method, nonce, verified_at, last_checked_at, failure_reason FROM domain_verifications WHERE project_id=$1", [s.project])).rows[0] as VerificationRow;
    await run(); // the sweep records the loss and notifies once
    expect(await notifications(s)).toHaveLength(1);

    const client = await pool.connect();
    try {
      const applied = await withTenantContext(client, { workspaceId: s.ws, actorId: SYSTEM_ACTOR_ID }, (tx) =>
        applyCheckOutcome(tx, { workspaceId: s.ws, projectId: s.project, domain: s.domain, row: stale, outcome: { ok: false, reason: "record_absent" }, now: NOW }),
      );
      expect(applied.methodLost).toBe(false);
    } finally {
      client.release();
    }
    expect(await notifications(s)).toHaveLength(1);
  });

  it("KAD-06 · no transaction is open while a domain is being checked", async () => {
    const s = await seed("kad06");
    publish(s);
    await run();
    expect(openTxDuringCheck.length).toBeGreaterThan(0);
    expect(openTxDuringCheck.every((n) => n === 0)).toBe(true);
  });

  it("review r4 AC7 · a target that now answers 503 is a conclusive failure: the file method is lost and the customer is told once", async () => {
    const s = await seed("file-5xx", { method: "well_known_file" });
    const down: CheckDeps = { ...checks(), fetch: async () => ({ status: 503, headers: {}, body: Buffer.from("") }) as never };
    const result = await run({ checks: down });
    expect((await verification(s, "well_known_file")).verified_at).toBeNull();
    expect(await mirror(s)).toBeNull();
    expect(await notifications(s)).toHaveLength(1);
    expect(result).toMatchObject({ checked: 1, lost: 1, inconclusive: 0 });
  });

  it("review r4 AC7 · a manual ok whose check STARTED before a sweep recorded the loss cannot restore scope on the older evidence", async () => {
    const s = await seed("stale-ok");
    const row = (await db.query("SELECT id, domain, method, nonce, verified_at, last_checked_at, failure_reason FROM domain_verifications WHERE project_id=$1", [s.project])).rows[0] as VerificationRow;
    await run(); // nothing published: the sweep commits the loss at NOW and notifies once
    expect(await notifications(s)).toHaveLength(1);

    const client = await pool.connect();
    try {
      const applied = await withTenantContext(client, { workspaceId: s.ws, actorId: SYSTEM_ACTOR_ID }, (tx) =>
        applyCheckOutcome(tx, {
          workspaceId: s.ws, projectId: s.project, domain: s.domain, row, outcome: { ok: true },
          checkStartedAt: new Date(NOW.getTime() - 60_000), now: new Date(NOW.getTime() + 1_000),
        }),
      );
      expect(applied).toMatchObject({ methodLost: false, scopeLost: false });
    } finally {
      client.release();
    }
    expect((await verification(s)).verified_at).toBeNull();
    expect(await mirror(s)).toBeNull();
    expect(new Date((await verification(s)).last_checked_at).getTime()).toBe(NOW.getTime());
    expect(await notifications(s)).toHaveLength(1);
  });

  // ---- review r5: an inconclusive result is bounded (AC7) ----------------------------------------------------------
  // A resolver outage must not de-verify the fleet in one night (round 1), but a domain whose DNS keeps failing is not
  // verified for ever either: the first inconclusive result of a run starts a clock, and when INCONCLUSIVE_GRACE_MS has
  // elapsed with no conclusive success the method is lost through the ordinary loss path.
  const sinceOf = async (s: Seeded, method = "dns_txt") =>
    (await db.query("SELECT inconclusive_since FROM domain_verifications WHERE project_id=$1 AND method=$2", [s.project, method])).rows[0].inconclusive_since as Date | null;
  const manualApply = async (s: Seeded, input: { outcome: Parameters<typeof applyCheckOutcome>[1]["outcome"]; now: Date; checkStartedAt?: Date }, method = "dns_txt"): Promise<Awaited<ReturnType<typeof applyCheckOutcome>>> => {
    const row = (await db.query("SELECT id, domain, method, nonce, verified_at, last_checked_at, failure_reason FROM domain_verifications WHERE project_id=$1 AND method=$2", [s.project, method])).rows[0] as VerificationRow;
    const client = await pool.connect();
    try {
      return await withTenantContext(client, { workspaceId: s.ws, actorId: SYSTEM_ACTOR_ID }, (tx) =>
        applyCheckOutcome(tx, { workspaceId: s.ws, projectId: s.project, domain: s.domain, row, ...input }),
      );
    } finally {
      client.release();
    }
  };
  const day = (k: number): Date => new Date(NOW.getTime() + k * 24 * HOUR);

  it("review r5 AC7 · a method that stays inconclusive for the whole grace window is lost on the first run at or after its end: cleared, mirrored, notified once, audited", async () => {
    const s = await seed("grace");
    resolverFails[s.domain] = "ESERVFAIL";
    const days = INCONCLUSIVE_GRACE_MS / (24 * HOUR);
    for (let k = 0; k < days; k += 1) {
      const result = await run({ now: () => day(k) });
      expect(result).toMatchObject({ checked: 1, lost: 0, inconclusive: 1 });
      expect((await verification(s)).verified_at, `still verified on day ${k}`).not.toBeNull();
      expect(await notifications(s)).toHaveLength(0);
    }
    // The clock started on day 0 and does not move while the result stays inconclusive.
    expect(new Date((await sinceOf(s))!).getTime()).toBe(day(0).getTime());

    const last = await run({ now: () => day(days) });
    expect(last).toMatchObject({ checked: 1, lost: 1 });
    expect((await verification(s)).verified_at).toBeNull();
    expect(await mirror(s)).toBeNull();
    expect(await notifications(s)).toHaveLength(1);
    expect((await auditRows(s)).map((r) => r.action)).toEqual(["project.domain_verification_lost"]);
    expect(await sinceOf(s)).toBeNull();

    await run({ now: () => day(days + 1) }); // never verified again: not a candidate, nothing repeats
    expect(await notifications(s)).toHaveLength(1);
  });

  it("review r5 AC7 · the window is exactly INCONCLUSIVE_GRACE_MS: one millisecond short keeps the method, the full window loses it", async () => {
    const s = await seed("boundary");
    const first = await manualApply(s, { outcome: { ok: false, reason: "record_absent", inconclusive: true }, now: NOW });
    expect(first).toMatchObject({ methodLost: false });
    const short = await manualApply(s, {
      outcome: { ok: false, reason: "record_absent", inconclusive: true }, now: new Date(NOW.getTime() + INCONCLUSIVE_GRACE_MS - 1),
    });
    expect(short).toMatchObject({ methodLost: false, scopeLost: false });
    expect((await verification(s)).verified_at).not.toBeNull();
    const full = await manualApply(s, {
      outcome: { ok: false, reason: "record_absent", inconclusive: true }, now: new Date(NOW.getTime() + INCONCLUSIVE_GRACE_MS),
    });
    expect(full).toMatchObject({ methodLost: true, scopeLost: true });
    expect((await verification(s)).verified_at).toBeNull();
    expect(await mirror(s)).toBeNull();
    expect(await notifications(s)).toHaveLength(1);
  });

  it("review r5 AC7 · a conclusive success clears the clock, so the window is measured from the NEXT inconclusive result", async () => {
    const s = await seed("reset");
    resolverFails[s.domain] = "ESERVFAIL";
    await run({ now: () => day(0) });
    expect(await sinceOf(s)).not.toBeNull();
    delete resolverFails[s.domain];
    publish(s);
    await run({ now: () => day(3) });
    expect(await sinceOf(s)).toBeNull();
    resolverFails[s.domain] = "ESERVFAIL";
    // Day 7 is 7 days after the FIRST spell began but only 3 after the second began on day 4: still verified.
    await run({ now: () => day(4) });
    await run({ now: () => day(7) });
    expect((await verification(s)).verified_at).not.toBeNull();
    expect(new Date((await sinceOf(s))!).getTime()).toBe(day(4).getTime());
  });

  it("review r5 AC7 · a conclusive failure after an inconclusive spell is an ordinary loss and leaves no clock behind", async () => {
    const s = await seed("conclusive-after");
    resolverFails[s.domain] = "ESERVFAIL";
    await run({ now: () => day(0) });
    delete resolverFails[s.domain]; // ENOTFOUND now: the record is gone
    await run({ now: () => day(1) });
    expect((await verification(s)).verified_at).toBeNull();
    expect(await sinceOf(s)).toBeNull();
    expect(await notifications(s)).toHaveLength(1);
  });

  it("review r5 AC7 · an inconclusive result on a method that was never verified starts no clock", async () => {
    const s = await seed("never", { verified: false });
    const applied = await manualApply(s, { outcome: { ok: false, reason: "record_absent", inconclusive: true }, now: NOW });
    expect(applied).toMatchObject({ methodLost: false, scopeLost: false });
    expect(await sinceOf(s)).toBeNull();
  });

  it("review r5 AC7 · the window applies per method: losing one of two on grace expiry keeps full scope and notifies nobody", async () => {
    const s = await seed("two-methods");
    await addMethod(s, "meta_tag", new Date(NOW.getTime() - 3 * 24 * HOUR), 30);
    await manualApply(s, { outcome: { ok: false, reason: "record_absent", inconclusive: true }, now: NOW });
    const lost = await manualApply(s, {
      outcome: { ok: false, reason: "record_absent", inconclusive: true }, now: new Date(NOW.getTime() + INCONCLUSIVE_GRACE_MS),
    });
    expect(lost).toMatchObject({ methodLost: true, scopeLost: false });
    expect(await notifications(s)).toHaveLength(0);
    expect(await mirror(s)).not.toBeNull();
  });

  it("review r5 AC7 · the window cannot be reached by a stale outcome: an older check discarded by freshness leaves the clock alone", async () => {
    const s = await seed("stale-clock");
    await manualApply(s, { outcome: { ok: false, reason: "record_absent", inconclusive: true }, now: NOW });
    const stale = await manualApply(s, {
      outcome: { ok: false, reason: "record_absent", inconclusive: true },
      now: new Date(NOW.getTime() + INCONCLUSIVE_GRACE_MS + 1_000),
      checkStartedAt: new Date(NOW.getTime() - 60_000), // started before the check committed at NOW
    });
    expect(stale).toMatchObject({ methodLost: false, scopeLost: false });
    expect((await verification(s)).verified_at).not.toBeNull();
  });

  it("review r5 AC7 · a manual check that STARTED first but committed first does not hide a sweep loss that started later", async () => {
    const s = await seed("manual-first");
    const manualStart = new Date(NOW.getTime() - 5 * 60 * 1000);
    const interleaved: CheckDeps = {
      ...checks(),
      resolveTxt: async () => {
        // The sweep's check began at NOW. While it is in flight a manual check that began EARLIER (manualStart) commits ok.
        await manualApply(s, { outcome: { ok: true }, now: manualStart, checkStartedAt: manualStart });
        throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }); // the sweep found the record gone
      },
    };
    const result = await run({ checks: interleaved });
    expect(result).toMatchObject({ checked: 1, lost: 1 });
    expect((await verification(s)).verified_at).toBeNull();
    expect(await mirror(s)).toBeNull();
    expect(await notifications(s)).toHaveLength(1);
  });

  it("review r5 · a verification row that vanishes between discovery and the check is skipped and counted as 'gone', not as a resolver outage", async () => {
    const s = await seed("vanished");
    let first = true;
    // The first pooled connection is the nonce read, which happens after discovery: the row is deleted just before it.
    const racing = {
      connect: async () => {
        if (first) {
          first = false;
          await db.query("DELETE FROM domain_verifications WHERE project_id=$1", [s.project]);
        }
        return pool.connect();
      },
    } as unknown as Pool;
    const context = { pool: racing, env } as unknown as QueueHandlerContext;
    const result = await createDomainReverifyHandler(context, {
      now: () => NOW,
      checks: { ...checks(), resolveTxt: async () => { throw new Error("must not be checked: the row is gone"); } },
    })(db, tick());
    expect(result).toMatchObject({ checked: 1, lost: 0, failed: 0, inconclusive: 0, gone: 1 });
    expect(counters.filter((c) => c.name === "nominara_domain_reverify_checked_total").map((c) => c.labels.outcome)).toEqual(["gone"]);
  });

  it("review r4 NFR-SEC-01 · cross-tenant discovery on the owner connection never selects a nonce; the nonce is read under the tenant's own RLS", async () => {
    const s = await seed("no-nonce");
    publish(s);
    const spy = new Client({ connectionString: container.getConnectionUri() });
    await spy.connect();
    const texts: string[] = [];
    const original = spy.query.bind(spy) as (...args: unknown[]) => unknown;
    (spy as unknown as { query: (...args: unknown[]) => unknown }).query = (...args: unknown[]) => {
      const first = args[0];
      texts.push(typeof first === "string" ? first : String((first as { text?: string }).text ?? ""));
      return original(...args);
    };
    try {
      const { runDomainReverification } = await import("../../src/lib/verification/reverify.js");
      const result = await runDomainReverification(spy, pool, { checks: checks(), now: () => NOW });
      // the check still used the right nonce: a published, matching record stays verified
      expect(result).toMatchObject({ checked: 1, lost: 0, failed: 0 });
      expect((await verification(s)).verified_at).not.toBeNull();
    } finally {
      await spy.end();
    }
    expect(texts.length).toBeGreaterThan(0);
    expect(texts.filter((t) => /nonce/i.test(t))).toEqual([]);
  });

  it("AC7 · one project that cannot be written does not stop the others: an explicit partial status, counted and logged by ID", async () => {
    const bad = await seed("poison");
    const good = await seed("clean");
    await db.query(`
      CREATE OR REPLACE FUNCTION reject_poison() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.workspace_id = '${bad.ws}' THEN RAISE EXCEPTION 'poisoned'; END IF; RETURN NEW; END $$`);
    await db.query("CREATE TRIGGER poison_notifications BEFORE INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION reject_poison()");
    const errors: string[] = [];
    const spy = vi.spyOn(Logger.prototype, "error").mockImplementation((m: unknown) => void errors.push(JSON.stringify(m)));
    let result: unknown;
    try {
      result = await run();
    } finally {
      spy.mockRestore();
    }

    expect(result).toMatchObject({ status: "partial", checked: 2, lost: 1, failed: 1 });
    // the failed one rolled back whole: still verified, so the NEXT run retries it
    expect((await verification(bad)).verified_at).not.toBeNull();
    expect((await verification(good)).verified_at).toBeNull();
    expect(counters.some((c) => c.name === "nominara_domain_reverify_failures_total")).toBe(true);
    const text = errors.join("\n");
    expect(text).toContain(bad.ws);
    expect(text).not.toContain(bad.domain);
  });

  it("review r3 · a check that THROWS is that candidate's failure, not the run's: the other domains are still checked and the status is partial", async () => {
    const broken = await seed("throws", { lastCheckedHoursAgo: 40 });
    const gone = await seed("gone", { lastCheckedHoursAgo: 30 });
    const base = checks();
    const errors: string[] = [];
    const spy = vi.spyOn(Logger.prototype, "error").mockImplementation((m: unknown) => void errors.push(JSON.stringify(m)));
    let result: unknown;
    try {
      // a malformed answer (not an array) throws OUTSIDE the resolver try/catch inside the checker
      result = await run({
        checks: { ...base, resolveTxt: async (name: string) => (name.includes(broken.domain) ? (null as never) : base.resolveTxt(name)) },
      });
    } finally {
      spy.mockRestore();
    }
    expect(result).toMatchObject({ status: "partial", checked: 2, lost: 1, failed: 1 });
    expect((await verification(gone)).verified_at).toBeNull();
    expect((await verification(broken)).verified_at).not.toBeNull();
    expect(errors.join("\n")).toContain(broken.ws);
    expect(errors.join("\n")).not.toContain(broken.domain);
  });

  it("single-flight · yields when another replica holds the lock, checking nothing", async () => {
    await seed("locked");
    expect(await tryAdvisorySessionLock(db, globalQueueLockKey("domain.reverify"))).toBe(true);
    try {
      const other = new Client({ connectionString: container.getConnectionUri() });
      await other.connect();
      try {
        const context = { pool, env } as unknown as QueueHandlerContext;
        const result = await createDomainReverifyHandler(context, { checks: checks(), now: () => NOW })(other, tick());
        expect(result).toMatchObject({ status: "yielded" });
      } finally {
        await other.end();
      }
      expect(resolveCalls).toEqual([]);
      expect(counters.map((c) => c.name)).toContain("nominara_domain_reverify_yielded_total");
    } finally {
      await db.query("SELECT pg_advisory_unlock_all()");
    }
  });

  it("observability · a span, run and loss counters, and a log line that carries IDs and counts only", async () => {
    const lost = await seed("obs");
    const logs: string[] = [];
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation((m: unknown) => void logs.push(JSON.stringify(m)));
    const log = vi.spyOn(Logger.prototype, "log").mockImplementation((m: unknown) => void logs.push(JSON.stringify(m)));
    try {
      await run();
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }

    const names = counters.map((c) => c.name);
    expect(names).toContain("nominara_domain_reverify_runs_total");
    expect(names).toContain("nominara_domain_reverify_lost_total");
    expect(counters.find((c) => c.name === "nominara_domain_reverify_runs_total")!.labels).toEqual({ status: "complete" });
    const span = exporter.getFinishedSpans().find((s) => s.name === "domain.reverify");
    expect(span).toBeDefined();
    expect(span!.attributes["nominara.domain_reverify.checked"]).toBe(1);
    expect(span!.attributes["nominara.domain_reverify.lost"]).toBe(1);
    const text = logs.join("\n");
    expect(text).toContain(lost.ws);
    expect(text).not.toContain(lost.domain);
    expect(text).not.toContain(lost.nonce);
    expect(text).not.toContain("W obs");
  });
});
