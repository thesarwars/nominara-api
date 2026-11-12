import { createHash, randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { Job } from "bullmq";
import { Client, Pool } from "pg";
import { inflateRawSync } from "node:zlib";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { retentionExportCoverageSchema } from "../../contracts/billing/index.js";
import { NotFoundError } from "../../src/api/errors/domain-errors.js";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { attributionPurgeList, rawPurgeList, recordRetentionShortening, rollupPurgeList } from "../../src/lib/billing/retention-shortening.js";
import { readExportScope } from "../../src/lib/billing/retention-export/scope.js";
import { encodeRawObject } from "../../src/lib/capture/raw-object.js";
import { signQueueJobPayload } from "../../src/lib/queue/envelope.js";
import { createBillingRetentionExportHandler } from "../../src/lib/queue/handlers/billing-retention-export.handler.js";
import type { QueueHandlerContext } from "../../src/lib/queue/handlers.js";
import { QUEUE_TOPOLOGY } from "../../src/lib/queue/topology.js";
import { createJobProcessor } from "../../src/lib/queue/worker-factory.js";
import { buildObjectLocation } from "../../src/lib/storage/storage-keys.js";
import type { ObjectHead, ObjectStoragePort, PutObjectRequest, StorageBucketName } from "../../src/lib/storage/storage.port.js";
import { TenantObjectStore } from "../../src/lib/storage/tenant-object-store.js";
import type { EmailMessage, EmailSender } from "../../src/modules/identity/ports/email-sender.js";
import { RetentionExportService } from "../../src/modules/billing/retention-export.service.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";
import { tryPurgeProject } from "../../src/workers/rollup/retention.js";

// STORY-185 / owner decision 100 - the full-data export, end to end on a real database under the RUNTIME role (`nominara_app`, FORCE RLS),
// through the real `createJobProcessor` (signature first; prepare and commit as separate tenant transactions around a run that holds neither
// a transaction nor a client). The object store is an in-memory port; the mail is a recording sender.

// Only the origin of the notice's export link is read from the environment, and only when an export exists.
vi.mock("../../src/config/env.js", () => ({ loadEnv: () => ({ OAUTH_REDIRECT_BASE_URL: "https://api.example.test" }) }));

const DAY = 86_400_000;
const KEYS = { current: { kid: "k1", key: Buffer.from("retention-export-test-signing-key-32") } };
const ENTRY = QUEUE_TOPOLOGY.find((entry) => entry.name === "billing.retention_export")!;
const KEY_ENV = "test";
const BASE = "https://api.example.test";

class MemoryPort implements ObjectStoragePort {
  readonly objects = new Map<string, Buffer>();
  puts = 0;
  presigns: string[] = [];
  onGet: (key: string) => Promise<void> = async () => {};
  onPut: (key: string) => Promise<void> = async () => {};
  async put(r: PutObjectRequest): Promise<void> {
    await this.onPut(r.key);
    this.puts += 1;
    this.objects.set(`${r.bucket}/${r.key}`, Buffer.from(r.body as Uint8Array));
  }
  async get(bucket: StorageBucketName, key: string): Promise<Buffer> {
    await this.onGet(key);
    const found = this.objects.get(`${bucket}/${key}`);
    if (found === undefined) throw new NotFoundError({ message: "no such object" });
    return found;
  }
  async head(): Promise<ObjectHead> {
    throw new Error("unused");
  }
  async delete(): Promise<void> {}
  async presignGet(bucket: StorageBucketName, key: string, seconds: number): Promise<string> {
    const url = `https://s3.example.test/${bucket}/${key}?sig=${randomUUID()}&exp=${String(seconds)}`;
    this.presigns.push(url);
    return url;
  }
}

class RecordingSender implements EmailSender {
  sent: EmailMessage[] = [];
  failNext = false;
  onSend: () => Promise<void> = async () => {};
  async send(message: EmailMessage): Promise<void> {
    await this.onSend();
    if (this.failNext) {
      this.failNext = false;
      throw new Error("provider down");
    }
    this.sent.push(message);
  }
}

/** Reads a zip back with an independent reader. */
function unzip(zip: Buffer): Map<string, Buffer> {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    const packed = zip.readUInt32LE(at + 20);
    const nameLen = zip.readUInt16LE(at + 28);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLen).toString("utf8");
    const dataAt = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    out.set(name, inflateRawSync(zip.subarray(dataAt, dataAt + packed)));
    at += 46 + nameLen;
  }
  return out;
}

describe("STORY-185 · the full-data export before a retention purge", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let pool: Pool;
  let port: MemoryPort;
  let sender: RecordingSender;
  let seq = 0;
  const NOW = new Date();

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18").withDatabase("nominara_test").withUsername("nominara").withPassword("nominara").start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await migrateUp(db);
    const password = resolvePassword("nominara_app", {});
    await db.query(`ALTER ROLE nominara_app PASSWORD ${db.escapeLiteral(password)}`);
    const uri = new URL(container.getConnectionUri());
    uri.username = "nominara_app";
    uri.password = password;
    pool = new Pool({ connectionString: uri.toString(), max: 8 });
  }, 300_000);

  afterAll(async () => {
    await pool.end();
    await db.end();
    await container.stop();
  });

  beforeEach(() => {
    port = new MemoryPort();
    sender = new RecordingSender();
  });

  // -- fixtures ---------------------------------------------------------------------------------------------------------------------------------
  async function user(email: string): Promise<string> {
    return (await db.query<{ id: string }>("INSERT INTO users (email) VALUES ($1) RETURNING id", [`${randomUUID().slice(0, 8)}-${email}`])).rows[0]!.id;
  }
  async function workspace(plan: string): Promise<string> {
    seq += 1;
    return (await db.query<{ id: string }>("INSERT INTO workspaces (name, slug, plan_key, billing_email) VALUES ($1, $2, $3, 'billing@example.com') RETURNING id", [`WS ${String(seq)}`, `ws-${String(seq)}-${randomUUID().slice(0, 6)}`, plan])).rows[0]!.id;
  }
  async function project(ws: string, name: string): Promise<string> {
    seq += 1;
    return (await db.query<{ id: string }>("INSERT INTO projects (workspace_id, name, slug, root_url, root_domain) VALUES ($1, $2, $3, 'https://example.com', 'example.com') RETURNING id", [ws, name, `p-${String(seq)}-${randomUUID().slice(0, 6)}`])).rows[0]!.id;
  }
  /** A capture older than `at`, with a raw object in the store holding `text`, one mention and one citation. */
  async function capture(ws: string, proj: string, at: Date, text: string, opts: { withObject?: boolean } = {}): Promise<string> {
    const id = randomUUID();
    const location = buildObjectLocation(KEY_ENV, ws, "raw", `${String(at.getUTCFullYear())}/${String(at.getUTCMonth() + 1).padStart(2, "0")}/${id}.json.gz`);
    if (opts.withObject !== false) port.objects.set(`${location.bucket}/${location.key}`, encodeRawObject({ format: "markdown", text }));
    await db.query(
      `INSERT INTO answer_captures (id, workspace_id, project_id, run_id, prompt_id, engine_key, captured_at, capture_mode, adapter_version, normalizer_version, content_hash, raw_object_key, response_excerpt, payload)
       VALUES ($1, $2, $3, gen_random_uuid(), gen_random_uuid(), 'gemini', $4, 'api', 'v1', 'v1', decode('00','hex'), $5, 'excerpt', '{}'::jsonb)`,
      [id, ws, proj, at.toISOString(), location.key],
    );
    await db.query(
      `INSERT INTO mention_facts (workspace_id, project_id, result_id, prompt_id, engine_key, captured_at, entity_type, entity_label, matched_alias, occurrence_index, char_start, char_end, first_token_index, prominence, sentiment_label, sentiment_score, sentiment_confidence, sentiment_method)
       VALUES ($1, $2, $3, gen_random_uuid(), 'gemini', $4, 'brand', 'Acme', 'acme', 0, 0, 4, 0, 0.5, 'neutral', 0, 0.5, 'lexicon')`,
      [ws, proj, id, at.toISOString()],
    );
    await db.query(
      `INSERT INTO citation_facts (workspace_id, project_id, result_id, prompt_id, engine_key, captured_at, slot_index, raw_url, normalized_url, url_hash, domain, position_weight)
       VALUES ($1, $2, $3, gen_random_uuid(), 'gemini', $4, 0, 'https://cited.example/a', 'https://cited.example/a', $5, 'cited.example', 1)`,
      [ws, proj, id, at.toISOString(), createHash("sha256").update(id).digest()],
    );
    return id;
  }
  async function metric(ws: string, proj: string, date: string, engine = "gemini"): Promise<void> {
    await db.query("INSERT INTO metric_daily (workspace_id, project_id, engine_key, entity_type, entity_id, metric_date, visibility_score) VALUES ($1, $2, $3, 'brand', gen_random_uuid(), $4, 12.5)", [ws, proj, engine, date]);
  }
  async function attribution(ws: string, proj: string, date: string, url = "https://example.com/p"): Promise<void> {
    await db.query(
      "INSERT INTO attribution_daily (workspace_id, project_id, metric_date, landing_url_hash, landing_url, referrer_class, sessions, country, device) VALUES ($1, $2, $3, $4, $5, 'chatgpt', 7, 'US', 'desktop')",
      [ws, proj, date, createHash("sha256").update(url).digest(), url],
    );
  }
  const inTenant = async <T>(ws: string, fn: (tx: Client) => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    try {
      return await withTenantContext(client, { workspaceId: ws, actorId: SYSTEM_ACTOR_ID }, (tx) => fn(tx as unknown as Client));
    } finally {
      client.release();
    }
  };
  /** The plan change as a writer does it: the plan is adopted, then the shortening is recorded (the deferral and the replaced windows). */
  async function shorten(ws: string, from: string, to: string): Promise<void> {
    await db.query("UPDATE workspaces SET plan_key = $2 WHERE id = $1", [ws, to]);
    await inTenant(ws, (tx) => recordRetentionShortening(tx, ws, { fromPlanKey: from, toPlanKey: to, requestId: `evt_${randomUUID()}`, now: NOW, actorUa: "operator:test-writer" }));
  }
  async function requestRow(ws: string, requestedBy: string | null, expiresAt = new Date(NOW.getTime() + 14 * DAY)): Promise<string> {
    const id = randomUUID();
    await db.query("INSERT INTO retention_exports (id, workspace_id, requested_by, expires_at) VALUES ($1, $2, $3, $4)", [id, ws, requestedBy, expiresAt.toISOString()]);
    return id;
  }
  const row = async (id: string) => (await db.query("SELECT * FROM retention_exports WHERE id = $1", [id])).rows[0]!;
  const planWindow = async (plan: string, key: string): Promise<number> => Number((await db.query<{ v: string }>("SELECT entitlements->$2->>'value' AS v FROM plans WHERE key = $1", [plan, key])).rows[0]!.v);

  async function runJob(ws: string, exportId: string, opts: { attemptsMade?: number; payloadWs?: string } = {}): Promise<void> {
    const context = { pool, env: { NODE_ENV: "test", OAUTH_REDIRECT_BASE_URL: BASE } } as unknown as QueueHandlerContext;
    const process = createJobProcessor(ENTRY, {
      keys: KEYS,
      getClient: () => pool.connect(),
      releaseClient: (client) => (client as unknown as { release(): void }).release(),
      process: createBillingRetentionExportHandler(context, { sender, store: new TenantObjectStore(port, KEY_ENV), apiBaseUrl: BASE, now: () => new Date() }),
    });
    const payload = { exportId, workspaceId: opts.payloadWs ?? ws, kid: "k1" };
    await process({ data: signQueueJobPayload(payload, KEYS.current.key), attemptsMade: opts.attemptsMade ?? 0, opts: { attempts: 4 } } as unknown as Job);
  }
  const idleInTransaction = async (): Promise<number> => Number((await db.query("SELECT count(*) AS n FROM pg_stat_activity WHERE usename = 'nominara_app' AND state LIKE 'idle in transaction%'")).rows[0].n);
  const storedZip = (): Buffer => {
    const keys = [...port.objects.keys()].filter((k) => k.startsWith("reports/"));
    expect(keys, "exactly one stored export").toHaveLength(1);
    return port.objects.get(keys[0]!)!;
  };

  /** business -> starter: raw 395 -> 90, rollups -> their new window. Two projects with data on both sides of both cutoffs; one capture only inside the window. */
  async function scenario() {
    const ws = await workspace("business");
    const requester = await user("owner@example.com");
    const site = await project(ws, "Acme Site");
    const blog = await project(ws, "Acme Blog");
    await shorten(ws, "business", "starter");
    const scope = await inTenant(ws, (tx) => readExportScope(tx, ws, new Date()));
    const rawCutoff = scope!.raw!.cutoff;
    const rollCutoff = scope!.rollups!.cutoff;
    const ids = {
      old1: await capture(ws, site, new Date(rawCutoff.getTime() - 40 * DAY), "OLD ANSWER ONE ünïcode"),
      old2: await capture(ws, site, new Date(rawCutoff.getTime() - 3 * DAY), "OLD ANSWER TWO"),
      blogOld: await capture(ws, blog, new Date(rawCutoff.getTime() - 5 * DAY), "BLOG OLD"),
      recent: await capture(ws, site, new Date(rawCutoff.getTime() + 2 * DAY), "RECENT STAYS"),
    };
    const day = (offset: number): string => new Date(rollCutoff.getTime() + offset * DAY).toISOString().slice(0, 10);
    await metric(ws, site, day(-30)); await metric(ws, site, day(-30), "chatgpt"); await metric(ws, site, day(-2)); await metric(ws, site, day(3));
    await metric(ws, blog, day(-9));
    await attribution(ws, site, day(-30)); await attribution(ws, site, day(-30), "https://example.com/other"); await attribution(ws, site, day(-1)); await attribution(ws, site, day(5));
    return { ws, requester, site, blog, ids, rawCutoff, rollCutoff, day };
  }

  // ------------------------------------------------------------------------------------------------------------------------------------------------
  it("AC1 · one zip per workspace, a folder per project: answers (text as stored + parsed facts) older than the new raw window, rollups and attribution older than the new rollup window, and nothing newer", async () => {
    const s = await scenario();
    const id = await requestRow(s.ws, s.requester);
    await runJob(s.ws, id);

    expect((await row(id)).status).toBe("ready");
    const files = unzip(storedZip());
    const coverage = retentionExportCoverageSchema.parse(JSON.parse(files.get("manifest.json")!.toString()));
    expect(coverage.projects.map((p) => p.name)).toEqual(["Acme Blog", "Acme Site"]);
    const siteFolder = coverage.projects.find((p) => p.name === "Acme Site")!.folder;
    const blogFolder = coverage.projects.find((p) => p.name === "Acme Blog")!.folder;
    expect([...files.keys()].sort()).toEqual(
      ["manifest.json", ...[siteFolder, blogFolder].flatMap((f) => [`${f}/answers.jsonl`, `${f}/attribution_daily.csv`, `${f}/metric_daily.csv`])].sort(),
    );

    const answers = files.get(`${siteFolder}/answers.jsonl`)!.toString().trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(answers.map((a) => a.result_id).sort()).toEqual([s.ids.old1, s.ids.old2].sort());
    const one = answers.find((a) => a.result_id === s.ids.old1)!;
    expect((one.raw as { text: string }).text, "the answer text as stored").toBe("OLD ANSWER ONE ünïcode");
    expect((one.mention_facts as Array<Record<string, unknown>>)[0]).toMatchObject({ entity_label: "Acme", matched_alias: "acme" });
    expect((one.citation_facts as Array<Record<string, unknown>>)[0]).toMatchObject({ domain: "cited.example" });
    expect(JSON.stringify(one), "no hash and no tenant id leaves with the facts").not.toMatch(/url_hash|workspace_id|project_id/);
    expect(files.get(`${siteFolder}/answers.jsonl`)!.toString()).not.toContain("RECENT STAYS");

    const metricLines = files.get(`${siteFolder}/metric_daily.csv`)!.toString().trim().split("\r\n");
    expect(metricLines[0]).toMatch(/^metric_date,engine_key,entity_type,entity_id,/);
    expect(metricLines.slice(1).map((l) => l.split(",")[0]).sort()).toEqual([s.day(-30), s.day(-30), s.day(-2)].sort());
    const attrLines = files.get(`${siteFolder}/attribution_daily.csv`)!.toString().trim().split("\r\n");
    expect(attrLines.slice(1).map((l) => l.split(",")[0]).sort()).toEqual([s.day(-30), s.day(-30), s.day(-1)].sort());
  });

  it("AC4 · the coverage (date ranges and counts per project) equals the retention notice's own purge list for the same cutoffs", async () => {
    const s = await scenario();
    const id = await requestRow(s.ws, s.requester);
    await runJob(s.ws, id);
    const coverage = retentionExportCoverageSchema.parse((await row(id)).coverage);

    const lists = await inTenant(s.ws, async (tx) => ({
      raw: await rawPurgeList(tx, s.ws, s.rawCutoff),
      rollups: await rollupPurgeList(tx, s.ws, s.rollCutoff),
      attribution: await attributionPurgeList(tx, s.ws, s.rollCutoff),
    }));
    for (const p of coverage.projects) {
      const raw = lists.raw.find((l) => l.projectId === p.project_id);
      const roll = lists.rollups.find((l) => l.projectId === p.project_id);
      const attr = lists.attribution.find((l) => l.projectId === p.project_id);
      expect(p.raw_answers).toMatchObject({ count: raw?.count ?? 0, unreadable: 0, oldest: raw?.oldest.toISOString() ?? null, newest: raw?.newest.toISOString() ?? null });
      expect(p.rollups).toMatchObject({ count: roll?.count ?? 0, oldest: roll?.oldest.toISOString().slice(0, 10) ?? null, newest: roll?.newest.toISOString().slice(0, 10) ?? null });
      expect(p.attribution).toMatchObject({ count: attr?.count ?? 0, oldest: attr?.oldest.toISOString().slice(0, 10) ?? null, newest: attr?.newest.toISOString().slice(0, 10) ?? null });
    }
    // The cutoffs are the notice's: the purge date minus the new window.
    const purge = new Date(coverage.purge_not_before).getTime();
    expect(new Date(coverage.projects[0]!.raw_answers!.cutoff).getTime()).toBe(purge - (await planWindow("starter", "retention.raw_captures_days")) * DAY);
    expect(new Date(coverage.projects[0]!.rollups!.cutoff).getTime()).toBe(purge - (await planWindow("starter", "retention.rollups_days")) * DAY);
    expect(coverage.complete).toBe(true);
  });

  it("AC1 · cancel-to-Free: only the raw section is in scope (Free has no rollup window), and the export still builds", async () => {
    const ws = await workspace("growth");
    const requester = await user("o@example.com");
    const p = await project(ws, "Only");
    await shorten(ws, "growth", "free");
    const scope = await inTenant(ws, (tx) => readExportScope(tx, ws, new Date()));
    expect(scope?.raw).not.toBeNull();
    await capture(ws, p, new Date(scope!.raw!.cutoff.getTime() - 10 * DAY), "FREE OLD");
    const id = await requestRow(ws, requester);
    await runJob(ws, id);
    const files = unzip(storedZip());
    const cov = retentionExportCoverageSchema.parse((await row(id)).coverage);
    expect(cov.projects[0]!.raw_answers!.count).toBe(1);
    expect(cov.projects[0]!.rollups).toBeNull();
    expect([...files.keys()].some((k) => k.endsWith("metric_daily.csv"))).toBe(false);
  });

  it("AC3 · each project's purge lock (EC-40) is held while its data is read: a purge of that project skips, and the lock is gone afterwards", async () => {
    const s = await scenario();
    const id = await requestRow(s.ws, s.requester);
    const purge = new Client({ connectionString: container.getConnectionUri() });
    await purge.connect();
    const outcomes: Array<{ project: string; outcome: unknown }> = [];
    port.onGet = async (key) => {
      // The raw object being read belongs to one of the projects: find which and try to purge that one NOW.
      const owner = await db.query<{ project_id: string }>("SELECT project_id FROM answer_captures WHERE raw_object_key = $1", [key]);
      const projectId = owner.rows[0]!.project_id;
      outcomes.push({ project: projectId, outcome: await tryPurgeProject(purge, projectId, async () => undefined) });
    };
    try {
      await runJob(s.ws, id);
      expect(outcomes, "one read per purged-list capture").toHaveLength(3);
      for (const o of outcomes) expect(o.outcome, "the purge skips an exported project").toEqual({ scope: "project", scopeId: o.project, reason: "export-lock-held" });
      for (const project of [s.site, s.blog]) {
        expect(await tryPurgeProject(purge, project, async () => undefined), "released after the build").toEqual({ scope: "project", scopeId: project, purged: true });
      }
    } finally {
      await purge.end();
    }
  });

  it("AC3 · no transaction is open while an object is read or while the zip is uploaded (ADR-0003)", async () => {
    const s = await scenario();
    const id = await requestRow(s.ws, s.requester);
    const seen: number[] = [];
    port.onGet = async () => void seen.push(await idleInTransaction());
    port.onPut = async () => void seen.push(await idleInTransaction());
    sender.onSend = async () => void seen.push(await idleInTransaction());
    await runJob(s.ws, id);
    expect(seen, "3 object reads, the upload, the email").toHaveLength(5);
    expect(seen.every((n) => n === 0), `idle-in-transaction counts during object I/O: ${seen.join(",")}`).toBe(true);
  });

  it("AC6 · costs 0 credits: the wallet, the ledger, the reservations, the quota counters and the report artifacts are untouched", async () => {
    const s = await scenario();
    const snapshot = async () =>
      (await db.query(
        `SELECT (SELECT count(*) FROM credit_ledger WHERE workspace_id = $1) AS ledger, (SELECT coalesce(sum(included_balance + purchased_balance + reserved), 0) FROM credit_wallets WHERE workspace_id = $1) AS wallet,
                (SELECT count(*) FROM usage_ledger WHERE workspace_id = $1) AS usage, (SELECT count(*) FROM usage_reservations WHERE workspace_id = $1) AS reservations,
                (SELECT count(*) FROM usage_counters WHERE workspace_id = $1) AS counters, (SELECT count(*) FROM report_artifacts WHERE workspace_id = $1) AS artifacts`,
        [s.ws],
      )).rows[0];
    const before = await snapshot();
    const id = await requestRow(s.ws, s.requester);
    await runJob(s.ws, id);
    expect((await row(id)).status).toBe("ready");
    expect(await snapshot()).toEqual(before);
  });

  it("AC3 · the row is `ready` only after the object is stored, and the email goes only after that; it carries the requester, the route link, the date, and no presigned URL", async () => {
    const s = await scenario();
    const id = await requestRow(s.ws, s.requester);
    const statuses: string[] = [];
    port.onPut = async () => void statuses.push(`put:${(await row(id)).status}`);
    sender.onSend = async () => void statuses.push(`send:${(await row(id)).status}`);
    await runJob(s.ws, id);
    expect(statuses).toEqual(["put:building", "send:ready"]);
    expect(sender.sent).toHaveLength(1);
    const mail = sender.sent[0]!;
    expect(mail.to).toMatch(/owner@example\.com$/);
    expect(mail.textBody).toContain(`${BASE}/v1/billing/retention-export/${id}/download`);
    expect(mail.textBody).toContain((await row(id)).expires_at.toISOString().slice(0, 10));
    expect(mail.textBody).not.toMatch(/X-Amz|sig=|s3\./);
    expect(mail.idempotencyKey).toBe(`retention-export/${id}`);
    expect((await row(id)).emailed_at).not.toBeNull();
  });

  it("delivery · an email failure leaves the export ready and is retried WITHOUT rebuilding; a finished job is not repeated", async () => {
    const s = await scenario();
    const id = await requestRow(s.ws, s.requester);
    sender.failNext = true;
    await expect(runJob(s.ws, id)).rejects.toThrow("provider down");
    expect((await row(id)).status).toBe("ready");
    expect((await row(id)).emailed_at).toBeNull();
    expect(port.puts).toBe(1);
    await runJob(s.ws, id, { attemptsMade: 1 });
    expect(port.puts, "no rebuild").toBe(1);
    expect(sender.sent).toHaveLength(1);
    await runJob(s.ws, id, { attemptsMade: 2 });
    expect(sender.sent, "no second email").toHaveLength(1);
    expect(port.puts).toBe(1);
  });

  it("AC2 · the deferral ended before the job ran: the export is failed `deferral_ended`, nothing is built or stored", async () => {
    const s = await scenario();
    const id = await requestRow(s.ws, s.requester);
    await db.query("UPDATE workspaces SET retention_purge_not_before = now() - interval '1 minute' WHERE id = $1", [s.ws]);
    await runJob(s.ws, id);
    expect(await row(id)).toMatchObject({ status: "failed", error_code: "deferral_ended" });
    expect(port.puts).toBe(0);
    expect(sender.sent).toHaveLength(0);
  });

  it("a failed upload retries, stays `building` until the LAST attempt, then the export is `failed` (build_failed) so the owner can ask again; the error still reaches the queue", async () => {
    const s = await scenario();
    const id = await requestRow(s.ws, s.requester);
    port.onPut = async () => {
      throw new Error("store down");
    };
    await expect(runJob(s.ws, id, { attemptsMade: 0 })).rejects.toThrow("store down");
    expect((await row(id)).status).toBe("building");
    await expect(runJob(s.ws, id, { attemptsMade: 3 })).rejects.toThrow("store down");
    expect(await row(id)).toMatchObject({ status: "failed", error_code: "build_failed", object_key: null });
    expect(sender.sent).toHaveLength(0);
  });

  it("an unreadable raw object is counted, the file says it is incomplete, and the readable answers are still in it", async () => {
    const ws = await workspace("business");
    const requester = await user("o@example.com");
    const p = await project(ws, "Gappy");
    await shorten(ws, "business", "starter");
    const scope = (await inTenant(ws, (tx) => readExportScope(tx, ws, new Date())))!;
    const good = await capture(ws, p, new Date(scope.raw!.cutoff.getTime() - 5 * DAY), "READABLE");
    await capture(ws, p, new Date(scope.raw!.cutoff.getTime() - 6 * DAY), "GONE", { withObject: false });
    const id = await requestRow(ws, requester);
    await runJob(ws, id);
    const cov = retentionExportCoverageSchema.parse((await row(id)).coverage);
    expect(cov.complete).toBe(false);
    expect(cov.projects[0]!.raw_answers).toMatchObject({ count: 1, unreadable: 1 });
    const lines = unzip(storedZip()).get(`${cov.projects[0]!.folder}/answers.jsonl`)!.toString().trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).result_id).toBe(good);
    expect(sender.sent[0]!.textBody).toMatch(/could not be read|not in the file/);
  });

  it("tenancy · another workspace's data is never in the zip, and a job naming workspace B with workspace A's export id builds nothing and changes nothing", async () => {
    const a = await scenario();
    const b = await workspace("business");
    const bProject = await project(b, "Beta Secret");
    await shorten(b, "business", "starter");
    const bScope = (await inTenant(b, (tx) => readExportScope(tx, b, new Date())))!;
    await capture(b, bProject, new Date(bScope.raw!.cutoff.getTime() - 5 * DAY), "BETA SECRET ANSWER");
    await metric(b, bProject, new Date(bScope.rollups!.cutoff.getTime() - 3 * DAY).toISOString().slice(0, 10));

    const idA = await requestRow(a.ws, a.requester);
    await runJob(a.ws, idA);
    const text = [...unzip(storedZip()).values()].map((v) => v.toString()).join("\n");
    expect(text).not.toContain("BETA SECRET");
    expect(text).not.toContain("Beta Secret");

    port.puts = 0;
    const idA2 = await requestRow(a.ws, a.requester);
    await runJob(b, idA2); // workspace B's context, A's export id
    expect(await row(idA2), "A's row is untouched by a job in B's context").toMatchObject({ status: "requested", object_key: null });
    expect(port.puts).toBe(0);
  });

  it("tenancy · RLS: workspace B's runtime-role context sees none of A's export rows and can update none", async () => {
    const a = await scenario();
    const b = await workspace("business");
    const id = await requestRow(a.ws, a.requester);
    const seen = await inTenant(b, async (tx) => (await tx.query("SELECT id FROM retention_exports")).rowCount);
    expect(seen).toBe(0);
    const updated = await inTenant(b, async (tx) => (await tx.query("UPDATE retention_exports SET status = 'failed' WHERE id = $1", [id])).rowCount);
    expect(updated).toBe(0);
    await expect(inTenant(b, (tx) => tx.query("INSERT INTO retention_exports (id, workspace_id, expires_at) VALUES (gen_random_uuid(), $1, now() + interval '1 day')", [a.ws]))).rejects.toMatchObject({ code: "42501" });
    expect((await row(id)).status).toBe("requested");
  });

  it("a soft-deleted project is exported and labelled as the notice labels it; two projects of one name get two folders", async () => {
    const ws = await workspace("business");
    const requester = await user("o@example.com");
    const p1 = await project(ws, "Twin");
    const p2 = await project(ws, "Twin");
    await shorten(ws, "business", "starter");
    const scope = (await inTenant(ws, (tx) => readExportScope(tx, ws, new Date())))!;
    await capture(ws, p1, new Date(scope.raw!.cutoff.getTime() - 5 * DAY), "ONE");
    await capture(ws, p2, new Date(scope.raw!.cutoff.getTime() - 5 * DAY), "TWO");
    await db.query("UPDATE projects SET deleted_at = now() WHERE id = $1", [p2]);
    const id = await requestRow(ws, requester);
    await runJob(ws, id);
    const cov = retentionExportCoverageSchema.parse((await row(id)).coverage);
    expect(cov.projects.map((p) => p.name).sort()).toEqual(["Twin", "Twin (deleted project)"]);
    expect(new Set(cov.projects.map((p) => p.folder)).size).toBe(2);
  });

  it("more captures than one page: every capture is exported exactly once, in order (keyset paging keeps microsecond precision)", async () => {
    const ws = await workspace("business");
    const requester = await user("o@example.com");
    const p = await project(ws, "Big");
    await shorten(ws, "business", "starter");
    const scope = (await inTenant(ws, (tx) => readExportScope(tx, ws, new Date())))!;
    const base = scope.raw!.cutoff.getTime() - 30 * DAY;
    const made: string[] = [];
    for (let i = 0; i < 205; i++) made.push(await capture(ws, p, new Date(base + Math.floor(i / 5) * 1000), `A${String(i)}`));
    // Several captures share one millisecond and differ only in microseconds: a cursor that rounds to ms would repeat or skip them.
    await db.query("UPDATE answer_captures SET captured_at = captured_at + (random() * 900)::int * interval '1 microsecond' WHERE project_id = $1", [p]);
    const id = await requestRow(ws, requester);
    await runJob(ws, id);
    const cov = retentionExportCoverageSchema.parse((await row(id)).coverage);
    const lines = unzip(storedZip()).get(`${cov.projects[0]!.folder}/answers.jsonl`)!.toString().trim().split("\n");
    const ids = lines.map((l) => JSON.parse(l).result_id as string);
    expect(ids).toHaveLength(205);
    expect(new Set(ids).size).toBe(205);
    expect([...ids].sort()).toEqual([...made].sort());
    expect(cov.projects[0]!.raw_answers!.count).toBe(205);
  }, 120_000);

  it("AC5 · the retention notice links to the export only once it exists: not while none is built, and with the route link once one is ready", async () => {
    const notice = async (ws: string): Promise<string> => (await db.query<{ text_body: string }>("SELECT text_body FROM downgrade_notices WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 1", [ws])).rows[0]!.text_body;
    const s = await scenario(); // the first shortening recorded its notice before any export existed
    expect(await notice(s.ws)).not.toMatch(/export|download/i);
    const pending = await requestRow(s.ws, s.requester); // requested, not built: still no link
    await shorten(s.ws, "business", "starter");
    expect(await notice(s.ws)).not.toMatch(/export|download/i);
    await runJob(s.ws, pending);
    expect((await row(pending)).status).toBe("ready");
    await shorten(s.ws, "business", "starter"); // a later notice, with the export now built
    expect(await notice(s.ws)).toContain(`${BASE}/v1/billing/retention-export/${pending}/download`);
    // An expired export is no export.
    await db.query("UPDATE retention_exports SET expires_at = $2 WHERE id = $1", [pending, new Date(NOW.getTime() - 1000).toISOString()]);
    await shorten(s.ws, "business", "starter");
    expect(await notice(s.ws)).not.toContain(pending);
  });

  it("a signed job naming a workspace with a bad export id (no such row) ends quietly", async () => {
    const s = await scenario();
    await runJob(s.ws, randomUUID());
    expect(port.puts).toBe(0);
  });

  // -- the request side, against the real database ------------------------------------------------------------------------------------------------
  describe("the request, the view and the download (service, real database)", () => {
    const enqueued: Array<{ name: string; ws: string; payload: unknown; key: string }> = [];
    const queues = { enqueueTenantJob: async (name: string, ws: string, payload: unknown, o: { idempotencyKey: string }) => (enqueued.push({ name, ws, payload, key: o.idempotencyKey }), {} as never) };
    const service = () => new RetentionExportService(new TenantObjectStore(port, KEY_ENV), BASE, queues as never);
    beforeEach(() => void (enqueued.length = 0));

    it("AC2 · refused while no retention-shortening deferral is pending (precondition_unmet), and the view says unavailable", async () => {
      const ws = await workspace("business");
      await expect(inTenant(ws, async () => service().request())).rejects.toMatchObject({ code: "precondition_unmet" });
      expect(await inTenant(ws, async () => service().view())).toEqual({ available: false, purge_not_before: null, export: null });
      expect((await db.query("SELECT count(*) AS n FROM retention_exports WHERE workspace_id = $1", [ws])).rows[0].n).toBe("0");
    });

    it("AC2 · available whatever the new plan's export entitlements are: a plan with NO exports at all (Free) can still request it", async () => {
      const ws = await workspace("growth");
      await shorten(ws, "growth", "free");
      const entitlements = (await db.query("SELECT entitlements FROM plans WHERE key = 'free'")).rows[0].entitlements as Record<string, { value: unknown }>;
      expect([entitlements["exports.csv"]!.value, entitlements["exports.pdf_per_cycle"]!.value], "Free has neither CSV nor PDF export").toEqual([false, 0]);
      const result = await inTenant(ws, async () => service().request());
      expect(result).toMatchObject({ status: "requested", download_url: null });
    });

    it("AC6 · the request records the row with the link lifetime capped at 14 days, and enqueues one signed-tenant job after the commit, keyed per export", async () => {
      const ws = await workspace("business");
      await shorten(ws, "business", "starter"); // the deferral is 15 days out: the cap (14) is the earlier
      const result = await inTenant(ws, async () => service().request());
      expect(new Date(result.expires_at).getTime() - Date.now()).toBeLessThanOrEqual(14 * DAY + 5_000);
      expect(new Date(result.expires_at).getTime() - Date.now()).toBeGreaterThan(14 * DAY - 60_000);
      await new Promise((r) => setTimeout(r, 50));
      expect(enqueued).toEqual([{ name: "billing.retention_export", ws, payload: { exportId: result.id }, key: `retexp:${ws}:${result.id}` }]);
    });

    it("the link lasts only as long as the deferral when that ends sooner than 14 days", async () => {
      const ws = await workspace("business");
      await shorten(ws, "business", "starter");
      const soon = new Date(Date.now() + 5 * DAY);
      await db.query("UPDATE workspaces SET retention_purge_not_before = $2 WHERE id = $1", [ws, soon.toISOString()]);
      const result = await inTenant(ws, async () => service().request());
      expect(new Date(result.expires_at).getTime()).toBe(soon.getTime());
    });

    it("concurrency · eight simultaneous requests make ONE export (the in-flight index), and every caller is answered with it", async () => {
      const ws = await workspace("business");
      await shorten(ws, "business", "starter");
      const results = await Promise.all(Array.from({ length: 8 }, () => inTenant(ws, async () => service().request())));
      expect(new Set(results.map((r) => r.id)).size).toBe(1);
      expect((await db.query("SELECT count(*) AS n FROM retention_exports WHERE workspace_id = $1", [ws])).rows[0].n).toBe("1");
    });

    it("a ready, unexpired export is answered as it is (no second build); a failed one is not reused", async () => {
      const ws = await workspace("business");
      await shorten(ws, "business", "starter");
      const first = await inTenant(ws, async () => service().request());
      await db.query("UPDATE retention_exports SET status = 'failed', error_code = 'build_failed' WHERE id = $1", [first.id]);
      const second = await inTenant(ws, async () => service().request());
      expect(second.id).not.toBe(first.id);
      expect(second.status).toBe("requested");
    });

    it("AC3 · the view reports `expired` once the link's date has passed and never a download_url then", async () => {
      const ws = await workspace("business");
      await shorten(ws, "business", "starter");
      const first = await inTenant(ws, async () => service().request());
      await db.query("UPDATE retention_exports SET expires_at = now() - interval '1 second' WHERE id = $1", [first.id]);
      const view = await inTenant(ws, async () => service().view());
      expect(view.export).toMatchObject({ id: first.id, status: "expired", download_url: null });
    });
  });
});
