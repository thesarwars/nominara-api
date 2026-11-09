import type { Job } from "bullmq";
import type { ClientBase, Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { ALIGNMENT_JOB } from "../../geo/alignment/index.js";
import { ACTOR_GUC, SYSTEM_ACTOR_ID, WORKSPACE_GUC } from "../../../tenancy/constants.js";
import { signQueueJobPayload } from "../envelope.js";
import type { QueueHandlerContext } from "../handlers.js";
import { QUEUE_TOPOLOGY } from "../topology.js";
import { createJobProcessor } from "../worker-factory.js";
import { createGeoAnalyzeHandler, type GeoAnalyzeDeps } from "./geo-analyze.handler.js";

// STORY-192 - the geo.analyze alignment handler, with the library steps faked at the seam: the order of trust (HMAC before any tenant context),
// the transaction runner bound to the verified workspace, the bindings (cl100k, the provider's model, the guarded fetcher) and the re-queue
// that replaces a sleep. The steps themselves are proved against Postgres in test/integration/geo-alignment-job.spec.ts.

const ENTRY = QUEUE_TOPOLOGY.find((entry) => entry.name === "geo.analyze")!;
const KEYS = { current: { kid: "k1", key: Buffer.from("geo-analyze-test-signing-key-32by") } };
const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const SESSION = "33333333-3333-4333-8333-333333333333";

const payload = (over: Record<string, unknown> = {}) => ({ kind: "alignment_session", projectId: PROJECT, sessionId: SESSION, attempt: 0, workspaceId: WORKSPACE, kid: "k1", ...over });
const draftPayload = (over: Record<string, unknown> = {}) => payload({ kind: "alignment_draft", dueAt: "2026-11-09 10:00:02.123456+00", ...over });
const jobOf = (body: Record<string, unknown>, key = KEYS.current.key): Job => ({ data: signQueueJobPayload(body as never, key) }) as unknown as Job;

function harness(deps: Partial<GeoAnalyzeDeps> = {}) {
  const queries: { sql: string; params: unknown[] | undefined }[] = [];
  let acquired = 0;
  const client = { query: vi.fn(async (sql: string, params?: unknown[]) => (queries.push({ sql, params }), { rows: [], rowCount: 0 })), release: vi.fn() } as unknown as ClientBase & { release: () => void };
  const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
  const requeue = vi.fn(async () => undefined);
  const context = { pool, env: { NODE_ENV: "test", EMBEDDING_PROVIDER: "stand-in" } } as unknown as QueueHandlerContext;
  const process = createJobProcessor(ENTRY, {
    keys: KEYS,
    getClient: () => {
      acquired += 1;
      return client;
    },
    process: createGeoAnalyzeHandler(context, { requeue, pool, enqueueEmbed: async () => undefined, ...deps }),
  });
  return { process, queries, requeue, client, pool, acquired: () => acquired };
}

describe("STORY-192 - the geo.analyze alignment handler", () => {
  it("AC job - a job whose signature does not verify is rejected BEFORE any client is acquired, any tenant context set or any step run", async () => {
    const advanceSession = vi.fn();
    const h = harness({ advanceSession: advanceSession as never });
    await expect(h.process(jobOf(payload(), Buffer.from("another-signing-key-of-32-bytes!!")))).rejects.toThrow();
    const tampered = jobOf(payload());
    (tampered.data as { payload: Record<string, unknown> }).payload.workspaceId = "99999999-9999-4999-8999-999999999999";
    await expect(h.process(tampered)).rejects.toThrow();
    expect(h.acquired()).toBe(0);
    expect(h.queries).toEqual([]);
    expect(advanceSession).not.toHaveBeenCalled();
  });

  it("AC job - the transaction runner is withTenantContext bound to the VERIFIED workspace and the system actor, and returns its client", async () => {
    const advanceSession = vi.fn(async (deps: { runInTx: <T>(fn: (tx: ClientBase) => Promise<T>) => Promise<T> }) => {
      await deps.runInTx(async (tx) => (await tx.query("SELECT 1"), undefined));
      return { state: "ready" as const, reason: null };
    });
    const h = harness({ advanceSession: advanceSession as never });
    await h.process(jobOf(payload()));
    const sets = h.queries.filter((q) => q.sql.includes("set_config")).map((q) => q.params);
    expect(sets).toContainEqual([WORKSPACE_GUC, WORKSPACE]);
    expect(sets).toContainEqual([ACTOR_GUC, SYSTEM_ACTOR_ID]);
    const order = h.queries.map((q) => q.sql);
    const probe = order.indexOf("SELECT 1");
    expect(order.slice(0, probe).some((s) => s.includes(WORKSPACE_GUC) || s.includes("set_config"))).toBe(true);
    expect(order.at(-1)).toBe("COMMIT");
    expect((h.client as unknown as { release: ReturnType<typeof vi.fn> }).release).toHaveBeenCalled();
  });

  it("AC job - the bindings: STORY-050's cl100k counter, the selected provider's model, and a page fetcher; the session id comes from the payload", async () => {
    const seen: { tokens?: number; model?: string; fetcher?: unknown; session?: string } = {};
    const advanceSession = vi.fn(async (deps: { tokenizer: { count(t: string): number }; providerModel: string; fetchPage: unknown }, id: string) => {
      Object.assign(seen, { tokens: deps.tokenizer.count("hello world, this is text"), model: deps.providerModel, fetcher: deps.fetchPage, session: id });
      return { state: "ready" as const, reason: null };
    });
    await harness({ advanceSession: advanceSession as never }).process(jobOf(payload()));
    expect(seen.tokens).toBe(6); // cl100k_base, not whitespace words (5) or characters
    expect(seen.model).toBe("stand-in-bow-1536");
    expect(typeof seen.fetcher).toBe("function");
    expect(seen.session).toBe(SESSION);
  });

  it("AC job - a step that is waiting for vectors queues the NEXT step, delayed, with attempt + 1; a finished one queues nothing", async () => {
    const waiting = harness({ advanceSession: (async () => ({ state: "waiting", reason: "vectors_pending" })) as never });
    await waiting.process(jobOf(payload({ attempt: 4 })));
    expect(waiting.requeue).toHaveBeenCalledTimes(1);
    expect(waiting.requeue).toHaveBeenCalledWith(expect.objectContaining({ kind: "alignment_session", sessionId: SESSION, attempt: 5, workspaceId: WORKSPACE }), ALIGNMENT_JOB.pollDelayMs);
    for (const state of ["ready", "stale", "failed", "settled", "gone"] as const) {
      const done = harness({ advanceSession: (async () => ({ state, reason: null })) as never });
      await done.process(jobOf(payload()));
      expect(done.requeue, state).not.toHaveBeenCalled();
    }
  });

  it("AC draft - waiting re-queues after the poll delay; a job that fired early re-queues for exactly the time left; a superseded or idle one queues nothing", async () => {
    const draft = (outcome: unknown) => harness({ advanceDraft: (async () => outcome) as never });
    const waiting = draft({ state: "waiting", dueInMs: null });
    await waiting.process(jobOf(draftPayload()));
    expect(waiting.requeue).toHaveBeenCalledWith(expect.objectContaining({ kind: "alignment_draft", attempt: 1, dueAt: "2026-11-09 10:00:02.123456+00" }), ALIGNMENT_JOB.pollDelayMs);
    const early = draft({ state: "not_due", dueInMs: 750 });
    await early.process(jobOf(draftPayload()));
    expect(early.requeue).toHaveBeenCalledWith(expect.objectContaining({ kind: "alignment_draft", attempt: 1, dueAt: "2026-11-09 10:00:02.123456+00" }), 750);
    for (const outcome of [{ state: "not_due", dueInMs: null }, { state: "idle", dueInMs: null }, { state: "ready", dueInMs: null }, { state: "failed", dueInMs: null }]) {
      const quiet = draft(outcome);
      await quiet.process(jobOf(draftPayload()));
      expect(quiet.requeue, outcome.state).not.toHaveBeenCalled();
    }
  });

  it("AC job - a payload that is not an alignment job (the queue also carries the daily analyses) is ignored, not retried; an unknown key is ignored too", async () => {
    const advanceSession = vi.fn();
    const h = harness({ advanceSession: advanceSession as never });
    await expect(h.process(jobOf({ projectId: PROJECT, analysis: "structure", workspaceId: WORKSPACE, kid: "k1" }))).resolves.toBeUndefined();
    await expect(h.process(jobOf(payload({ unexpected: true })))).resolves.toBeUndefined();
    expect(advanceSession).not.toHaveBeenCalled();
    expect(h.requeue).not.toHaveBeenCalled();
  });

  it("AC job - a runaway chain of re-queues stops at the attempt cap instead of queueing for ever", async () => {
    const advanceSession = vi.fn();
    const h = harness({ advanceSession: advanceSession as never });
    await h.process(jobOf(payload({ attempt: 501 })));
    expect(advanceSession).not.toHaveBeenCalled();
    expect(h.requeue).not.toHaveBeenCalled();
  });

  it("AC job - a failing step is thrown to the queue's retry ladder, never swallowed", async () => {
    const h = harness({ advanceSession: (async () => { throw new Error("db down"); }) as never });
    await expect(h.process(jobOf(payload()))).rejects.toThrow("db down");
  });
});
