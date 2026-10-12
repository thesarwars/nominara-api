import { describe, expect, it } from "vitest";
import { QUEUE_TOPOLOGY, queueTopologySchema } from "../../../src/lib/queue/topology.js";

// STORY-030 T1 (RED step) — architecture reference §4's 21-queue table,
// transcribed by hand so this file is the executable ground truth for
// concurrency, retry ladder, priority, idempotency key, and tenant scoping.
// `src/lib/queue/topology.ts` does not exist yet; this file only proves the
// shape every queue must satisfy once it does.

const GLOBAL_REMOVE_ON_COMPLETE = { age: 3600, count: 5000 } as const;
const GLOBAL_REMOVE_ON_FAIL = { age: 604800 } as const;

// Retry ladders: capture.plan states explicit millisecond endpoints
// ("3× exp 2s→8s") that fully determine its 3-step array, used verbatim.
// capture.execute states ONLY its endpoints and step count ("4× exp
// 5s→120s ... max 4 attempts", per edge-cases-and-slos.md EC-06) — the two
// INTERIOR values (attempts 2 and 3) are not derivable from anything cited,
// so this file does not pin them; see the dedicated capture.execute test
// below, which checks exactly what IS specified (4 steps, 5000, 120000,
// strictly increasing) rather than re-asserting the implementation's own
// interpolation choice. Every other queue with a retry count and no stated
// endpoints (whether written "N× exp" or bare "N×") defaults to
// base-2000ms doubling, delaysMs[i] = 2000 * 2^i, for N steps — that
// convention is this story's own documented choice, not presented as
// spec, so pinning its exact output is legitimate. deploy.cms states "no
// automatic retry", so its ladder is empty.
function doubling(steps: number): number[] {
  return Array.from({ length: steps }, (_, i) => 2000 * 2 ** i);
}

const QUEUES_WITH_UNSPECIFIED_INTERIOR_RETRY_VALUES = new Set(["capture.execute"]);

const EXPECTED_QUEUE_TOPOLOGY = [
  {
    name: "capture.plan",
    producer: "scheduler cron, API",
    workerGroup: "capture",
    concurrency: 4,
    retry: { delaysMs: [2000, 4000, 8000] },
    priority: 5,
    idempotencyKeyPattern: "run:{project}:{window}",
    tenantScoped: true,
  },
  {
    name: "capture.execute",
    producer: "capture.plan",
    workerGroup: "capture",
    concurrency: 6,
    // Interior values (15000, 45000) are this implementation's own
    // interpolation between the spec's stated endpoints — excluded from
    // the entry-for-entry equality check below; see the dedicated test.
    retry: { delaysMs: [5000, 15000, 45000, 120000] },
    priority: { scheduled: 5, interactive: 1 },
    idempotencyKeyPattern: "cap:{prompt}:{engine}:{run}",
    tenantScoped: true,
  },
  {
    name: "capture.parse",
    producer: "capture",
    workerGroup: "parse",
    concurrency: 12,
    retry: { delaysMs: doubling(3) },
    priority: 4,
    idempotencyKeyPattern: "parse:{result}",
    tenantScoped: true,
  },
  {
    name: "capture.arbitrate",
    producer: "parse",
    workerGroup: "parse",
    concurrency: 6,
    retry: { delaysMs: doubling(2) },
    priority: 4,
    idempotencyKeyPattern: "arb:{mention}",
    tenantScoped: true,
  },
  {
    name: "lookup.execute",
    producer: "API (tools)",
    workerGroup: "capture",
    concurrency: 8,
    retry: { delaysMs: doubling(2) },
    priority: 1,
    idempotencyKeyPattern: "lookup:{tool_run_id}",
    tenantScoped: true,
  },
  {
    name: "crawl.discover",
    producer: "POST /projects",
    workerGroup: "crawl",
    concurrency: 3,
    retry: { delaysMs: doubling(2) },
    priority: 1,
    idempotencyKeyPattern: "disc:{project}",
    tenantScoped: true,
  },
  {
    name: "crawl.fingerprint",
    producer: "projects module",
    workerGroup: "crawl",
    concurrency: 4,
    retry: { delaysMs: doubling(2) },
    priority: 3,
    idempotencyKeyPattern: "fp:{project}",
    tenantScoped: true,
  },
  {
    name: "crawl.audit",
    producer: "API, cron",
    workerGroup: "crawl",
    concurrency: 3,
    retry: { delaysMs: doubling(3) },
    priority: 6,
    idempotencyKeyPattern: "aux:{project}:{audit}",
    tenantScoped: true,
  },
  {
    name: "embed.batch",
    producer: "parse, geo, crawl",
    workerGroup: "embed",
    concurrency: 4,
    retry: { delaysMs: doubling(3) },
    priority: 6,
    idempotencyKeyPattern: "emb:{sha256(batch)}",
    tenantScoped: true,
  },
  {
    name: "rollup.metric_daily",
    producer: "cron hourly, parse",
    workerGroup: "rollup",
    concurrency: 2,
    retry: { delaysMs: doubling(5) },
    priority: 7,
    idempotencyKeyPattern: "rollup:{project}:{date}",
    tenantScoped: true,
  },
  {
    name: "displacement.detect",
    producer: "rollup, after each parse batch",
    workerGroup: "rollup",
    concurrency: 4,
    retry: { delaysMs: doubling(3) },
    priority: 5,
    idempotencyKeyPattern: "disp:{project}:{prompt}:{engine}:{run}",
    tenantScoped: true,
  },
  {
    name: "geo.analyze",
    producer: "cron daily, API",
    workerGroup: "rollup",
    concurrency: 2,
    retry: { delaysMs: doubling(3) },
    priority: 6,
    idempotencyKeyPattern: "geo:{project}:{analysis}:{window}",
    tenantScoped: true,
  },
  {
    name: "topic.cluster",
    producer: "prompt-set change >= 10%, cron weekly",
    workerGroup: "embed",
    concurrency: 2,
    retry: { delaysMs: doubling(3) },
    priority: 7,
    idempotencyKeyPattern: "topic:{project}:{prompt_set_hash}",
    tenantScoped: true,
  },
  {
    name: "task.generate",
    producer: "rollup, aux",
    workerGroup: "rollup",
    concurrency: 4,
    retry: { delaysMs: doubling(3) },
    priority: 6,
    idempotencyKeyPattern: "taskgen:{project}:{rule}:{fingerprint}",
    tenantScoped: true,
  },
  {
    name: "attribution.rollup",
    producer: "cron hourly, ingest watermark",
    workerGroup: "rollup",
    concurrency: 2,
    retry: { delaysMs: doubling(3) },
    priority: 7,
    idempotencyKeyPattern: "attr:{project}:{window}",
    tenantScoped: true,
  },
  {
    name: "gsc.sync",
    producer: "cron daily, API",
    workerGroup: "crawl",
    concurrency: 2,
    retry: { delaysMs: doubling(4) },
    priority: 7,
    idempotencyKeyPattern: "gsc:{connection}:{date}",
    tenantScoped: true,
  },
  {
    name: "credit.reconcile",
    producer: "cron every 10 min",
    workerGroup: "rollup",
    concurrency: 1,
    retry: { delaysMs: doubling(3) },
    priority: 9,
    idempotencyKeyPattern: "creditrec:{bucket}",
    tenantScoped: false,
  },
  {
    name: "report.build",
    producer: "API, cron",
    workerGroup: "report",
    concurrency: 3,
    retry: { delaysMs: doubling(3) },
    priority: 8,
    idempotencyKeyPattern: "rep:{report}:{period}",
    tenantScoped: true,
  },
  {
    name: "notify.dispatch",
    producer: "any",
    workerGroup: "rollup",
    concurrency: 8,
    retry: { delaysMs: doubling(5) },
    priority: 8,
    idempotencyKeyPattern: "ntf:{event}",
    tenantScoped: true,
  },
  {
    name: "maintenance.partition",
    producer: "cron monthly",
    workerGroup: "rollup",
    concurrency: 1,
    retry: { delaysMs: doubling(3) },
    priority: 9,
    idempotencyKeyPattern: "part:{yyyy_mm}",
    tenantScoped: false,
  },
  {
    name: "deploy.cms",
    producer: "API",
    workerGroup: "deploy",
    concurrency: 2,
    retry: { delaysMs: [] },
    priority: 1,
    idempotencyKeyPattern: "deploy:{Idempotency-Key}",
    tenantScoped: true,
  },
].map((entry) => ({
  ...entry,
  removeOnComplete: GLOBAL_REMOVE_ON_COMPLETE,
  removeOnFail: GLOBAL_REMOVE_ON_FAIL,
}));

const EXPECTED_GROUP_COUNTS: Record<string, number> = {
  capture: 3,
  parse: 2,
  crawl: 4,
  embed: 2,
  rollup: 8,
  report: 1,
  deploy: 1,
};


/**
 * ⚠ QUEUES THIS REPOSITORY DECLARES THAT §4 DOES NOT, kept apart from the
 * transcription above so the reference stays quotable and the additions stay
 * countable. Adding a queue is a change to the architecture, and it belongs in
 * a list with a reason rather than silently inside a table that claims to be a
 * copy of §4.
 */
const ADDED_BEYOND_REFERENCE: Record<string, { workerGroup: string; because: string }> = {
  "audit.verify": {
    workerGroup: "rollup",
    because:
      "security-and-tenancy.md §12 requires a verifier job that re-walks each audit chain daily and pages on the first mismatch. " +
      "§4's table never allocated it a queue, so STORY-020 wrote the job (workers/rollup/audit-verify.ts) with nowhere to run it — " +
      "no handler, no schedule, and not even a pnpm script, while two comments in this repo claimed it ran daily. STORY-143.",
  },
  "identity.sweep_unverified": {
    workerGroup: "rollup",
    because:
      "An email-code request for an unknown address creates that account unverified (STORY-173), and the rows nobody came back for must not " +
      "accumulate or stay squatted. The sweep (workers/rollup/unverified-sweep.ts) is a job §4 never allocated a queue; the owner decided it runs " +
      "daily on this system rather than by hand. A queue of its own so a DLQ entry names the job that failed. STORY-173.",
  },
  "source.verify_presence": {
    workerGroup: "crawl",
    because:
      "STORY-054 AC4/AC11: brand presence on a cited domain is verified by FETCHING the cited URL through the guarded fetcher and matching it, " +
      "cached 30 days (scoring-models.md §5). §4's table allocates no queue to that fetch, and a fetch of a third-party site must never run on a " +
      "request path (KAD-06) nor inside the rollup transaction. A queue of its own, in the crawl group with the other outbound fetchers, so a DLQ " +
      "entry names the job that failed. NEW-C-15.",
  },
  "billing.auto_topup": {
    workerGroup: "rollup",
    because:
      "NEW-D-7 / owner decision 4 of 2026-10-08: an auto top-up charges a saved card through Stripe, which may never happen on a request path (KAD-06). " +
      "A balance debit that leaves a workspace below its threshold enqueues one signed tenant job; the worker verifies the signature before any context is " +
      "set, then evaluates and charges. §4's table allocates no queue to it. A queue of its own so a DLQ entry names the job that failed. STORY-076.",
  },
  "credit.housekeeping": {
    workerGroup: "rollup",
    because:
      "STORY-076 AC4 / STORY-071 AC10: purchased credits expire FIFO twelve months after purchase (plans-and-entitlements.md §5) and credit_daily_counters rows " +
      "older than 35 days are purged nightly (schemas/billing-and-credits.md). expireCredits and purgeDailyCounters were built and tested and had no caller. " +
      "§4's table allocates no queue to either. One queue because both need the same privileged cross-tenant connection; independent steps in the handler.",
  },
  "retention.purge": {
    workerGroup: "rollup",
    because:
      "STORY-077 R4 / STORY-013: runDailyPurgeCycle (data-model.md §7, 'nightly') hard-deletes soft-deleted projects past 30 days and workspaces past their " +
      "deletion grace, and had no caller. §4's table allocates it no queue. The handler is a no-op unless RETENTION_PURGE_ENABLED=true — it deletes customer data.",
  },
};

describe("STORY-030 · queue topology declares §4's 21 queues, plus what we have added on purpose", () => {
  it("transcribes §4's twenty-one entry-for-entry, and adds exactly the queues named as additions", () => {
    expect(EXPECTED_QUEUE_TOPOLOGY).toHaveLength(21);
    // ⚠ THE COUNT IS DERIVED, so a 23rd queue cannot appear without either a
    // line in ADDED_BEYOND_REFERENCE or this failing.
    expect(QUEUE_TOPOLOGY).toHaveLength(21 + Object.keys(ADDED_BEYOND_REFERENCE).length);

    const referenceNames = new Set(EXPECTED_QUEUE_TOPOLOGY.map((entry) => entry.name));
    const extra = QUEUE_TOPOLOGY.map((entry) => entry.name).filter((name) => !referenceNames.has(name));
    expect(extra.sort()).toEqual(Object.keys(ADDED_BEYOND_REFERENCE).sort());
    for (const entry of Object.values(ADDED_BEYOND_REFERENCE)) {
      expect(entry.because.length).toBeGreaterThan(60);
    }

    const byName = new Map(QUEUE_TOPOLOGY.map((entry) => [entry.name, entry]));
    for (const expected of EXPECTED_QUEUE_TOPOLOGY) {
      const actual = byName.get(expected.name);
      if (QUEUES_WITH_UNSPECIFIED_INTERIOR_RETRY_VALUES.has(expected.name)) {
        // capture.execute's interior retry values are not spec-derivable —
        // compare every OTHER field exactly, and leave the retry ladder's
        // shape to the dedicated test below.
        const { retry: _expectedRetry, ...expectedRest } = expected;
        const { retry: _actualRetry, ...actualRest } = actual ?? ({} as typeof expected);
        expect(actualRest).toEqual(expectedRest);
      } else {
        expect(actual).toEqual(expected);
      }
    }
  });

  it("capture.execute's retry ladder matches only what the reference actually specifies — 4 attempts, 5s→120s, strictly increasing (interior values are this implementation's own interpolation, not from the spec)", () => {
    const captureExecute = QUEUE_TOPOLOGY.find((entry) => entry.name === "capture.execute");
    const delaysMs = captureExecute?.retry.delaysMs ?? [];
    expect(delaysMs).toHaveLength(4);
    expect(delaysMs[0]).toBe(5000);
    expect(delaysMs[3]).toBe(120000);
    for (let i = 1; i < delaysMs.length; i++) {
      expect(delaysMs[i]).toBeGreaterThan(delaysMs[i - 1]!);
    }
  });

  it("has the documented per-worker-group queue counts (rollup carries the added queues)", () => {
    const actualCounts: Record<string, number> = {};
    for (const entry of QUEUE_TOPOLOGY) {
      actualCounts[entry.workerGroup] = (actualCounts[entry.workerGroup] ?? 0) + 1;
    }
    // ⚠ THE GROUP COMES FROM THE RECORD, NOT FROM THE TOPOLOGY. The first
    // version read `QUEUE_TOPOLOGY.find(name)!.workerGroup` — the actual value
    // — which made the expectation self-satisfying, while its comment claimed
    // it caught a misplaced addition. A review moved `audit.verify` to the
    // capture group and this test stayed green. Declaring the group alongside
    // the reason is what makes it an assertion.
    const expectedCounts = { ...EXPECTED_GROUP_COUNTS };
    for (const added of Object.values(ADDED_BEYOND_REFERENCE)) {
      expectedCounts[added.workerGroup] = (expectedCounts[added.workerGroup] ?? 0) + 1;
    }
    expect(actualCounts).toEqual(expectedCounts);
  });

  it("uses a .strict() zod schema, and every one of the 21 entries parses against it", () => {
    // A `.strict()` object schema rejects an unknown key — the defining,
    // load-bearing behavior distinguishing it from a passthrough schema.
    const strictnessProbe = queueTopologySchema.safeParse({
      ...EXPECTED_QUEUE_TOPOLOGY[0],
      unknownKey: "should not be tolerated",
    });
    expect(strictnessProbe.success).toBe(false);

    for (const entry of QUEUE_TOPOLOGY) {
      const result = queueTopologySchema.safeParse(entry);
      expect(result.success, `queue "${entry.name}" must parse against queueTopologySchema`).toBe(true);
    }
  });

  it("applies the global removeOnComplete/removeOnFail defaults to every one of the 21 entries", () => {
    for (const entry of QUEUE_TOPOLOGY) {
      expect(entry.removeOnComplete, `${entry.name}.removeOnComplete`).toEqual(GLOBAL_REMOVE_ON_COMPLETE);
      expect(entry.removeOnFail, `${entry.name}.removeOnFail`).toEqual(GLOBAL_REMOVE_ON_FAIL);
    }
  });

  it("marks tenantScoped=false only for the six cross-tenant system jobs; true for every other queue", () => {
    // ⚠ THE SHORT LIST IS THE ASSERTION. A tenant-scoped queue cannot be
    // driven by a bare cron tick — `createJobProcessor` verifies a signature
    // before the handler is reached — so this set is exactly the set of
    // queues a scheduler can produce for, and `schedule-registrar.ts` refuses
    // the rest. `audit.verify` joins it because a verifier that could only see
    // one workspace would not be a verifier.
    const systemScoped = QUEUE_TOPOLOGY.filter((entry) => !entry.tenantScoped).map((entry) => entry.name).sort();
    expect(systemScoped).toEqual([
      "audit.verify",
      "credit.housekeeping",
      "credit.reconcile",
      "identity.sweep_unverified",
      "maintenance.partition",
      "retention.purge",
    ]);
  });

  it("configures deploy.cms with an empty retry ladder — a single attempt, no automatic retry", () => {
    const deployCms = QUEUE_TOPOLOGY.find((entry) => entry.name === "deploy.cms");
    expect(deployCms?.retry.delaysMs).toEqual([]);
  });
});
