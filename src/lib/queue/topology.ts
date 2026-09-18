import { z } from "zod";

// STORY-030 — the 21-queue table transcribed from
// Nominara-Dev-Docs-main/references/system-architecture.md §4. This is the
// executable single source of truth queue registration/worker wiring reads
// from later in this story; test/unit/queue/topology.spec.ts is an
// independently hand-transcribed pin against the same reference table, so
// a typo here fails against that second transcription rather than only
// against itself.
//
// Retry ladders: two queues state explicit millisecond endpoints in the
// reference table (capture.plan "3× exp 2s→8s", capture.execute "4× exp
// 5s→120s + jitter → DLQ") — those exact arrays are used verbatim. Every
// other queue with a retry count and no stated endpoints (whether written
// "N× exp" or bare "N×") defaults to base-2000ms doubling,
// delaysMs[i] = 2000 * 2^i, for N steps. deploy.cms states "no automatic
// retry", so its ladder is empty (a single attempt).

export const QUEUE_WORKER_GROUPS = ["capture", "parse", "crawl", "embed", "rollup", "report", "deploy"] as const;

const GLOBAL_REMOVE_ON_COMPLETE = { age: 3600, count: 5000 } as const;
const GLOBAL_REMOVE_ON_FAIL = { age: 604800 } as const;

export const queueTopologySchema = z
  .object({
    name: z.string().min(1),
    producer: z.string().min(1),
    workerGroup: z.enum(QUEUE_WORKER_GROUPS),
    concurrency: z.number().int().positive(),
    retry: z
      .object({
        delaysMs: z.array(z.number().int().nonnegative()),
      })
      .strict(),
    // capture.execute is the one queue the reference table gives a dual
    // priority ("5 scheduled / 1 interactive") — every other queue has a
    // single documented priority number.
    priority: z.union([
      z.number().int().positive(),
      z
        .object({
          scheduled: z.number().int().positive(),
          interactive: z.number().int().positive(),
        })
        .strict(),
    ]),
    idempotencyKeyPattern: z.string().min(1),
    tenantScoped: z.boolean(),
    removeOnComplete: z
      .object({
        age: z.literal(GLOBAL_REMOVE_ON_COMPLETE.age),
        count: z.literal(GLOBAL_REMOVE_ON_COMPLETE.count),
      })
      .strict(),
    removeOnFail: z.object({ age: z.literal(GLOBAL_REMOVE_ON_FAIL.age) }).strict(),
  })
  .strict();

export type QueueTopologyEntry = z.infer<typeof queueTopologySchema>;

function doubling(steps: number): number[] {
  return Array.from({ length: steps }, (_, i) => 2000 * 2 ** i);
}

type RawQueueTopologyEntry = Omit<QueueTopologyEntry, "removeOnComplete" | "removeOnFail">;

const RAW_QUEUE_TOPOLOGY: readonly RawQueueTopologyEntry[] = [
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
    // Only the endpoints (5000, 120000) and the step count (4) are cited
    // (system-architecture.md §4 + edge-cases-and-slos.md EC-06: "5s→120s
    // ... max 4 attempts"). The interior values (15000, 45000) are this
    // implementation's own interpolation choice, not derived from the
    // reference — topology.spec.ts and backoff.spec.ts deliberately do not
    // pin them.
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
  // ⚠ THE ONE QUEUE §4 DOES NOT CONTAIN, and the divergence is deliberate.
  // `security-and-tenancy.md` §12 requires it — "A verifier job re-walks each
  // chain daily and pages on the first mismatch" — and §4's table simply never
  // allocated it a home, so the job was written (`workers/rollup/audit-verify.ts`,
  // STORY-020, complete with a paging notifier) and had nowhere to run. It had
  // no pnpm script either, so it was reachable ONLY from its own tests, while
  // two comments in this repo claimed it ran daily.
  //
  // Added rather than folded into `maintenance.partition` so that each queue
  // keeps meaning one thing: an operator reading a DLQ entry or a boot line can
  // tell which job failed. `test/unit/queue/topology.spec.ts` keeps §4's
  // twenty-one transcribed exactly and lists this separately with its reason,
  // so the reference and the addition never blur together.
  //
  // Not tenant-scoped: `listAuditedWorkspaceIds` walks every workspace, which
  // is the whole point of a verifier. Advisory-locked for the reason
  // `locks.ts` gives for `credit.reconcile` — concurrency 1 bounds one Worker
  // instance, not the queue, so two replicas would both walk every chain.
  {
    name: "audit.verify",
    producer: "cron daily (security-and-tenancy.md §12; not in §4)",
    workerGroup: "rollup",
    concurrency: 1,
    retry: { delaysMs: doubling(3) },
    priority: 9,
    idempotencyKeyPattern: "auditver:{yyyy_mm_dd}",
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
];

/** Parsed and frozen at module load — a malformed entry fails fast at import time, not on first use. */
export const QUEUE_TOPOLOGY: readonly QueueTopologyEntry[] = RAW_QUEUE_TOPOLOGY.map((entry) =>
  queueTopologySchema.parse({
    ...entry,
    removeOnComplete: GLOBAL_REMOVE_ON_COMPLETE,
    removeOnFail: GLOBAL_REMOVE_ON_FAIL,
  }),
);

const BY_NAME = new Map(QUEUE_TOPOLOGY.map((entry) => [entry.name, entry]));

/**
 * The topology entry for `name`, or a throw. Callers that reach here with a
 * name are working from the topology already — `QUEUE_TOPOLOGY.find(...)!`
 * spelled once, with the non-null assertion replaced by a real error.
 */
export function topologyFor(name: string): QueueTopologyEntry {
  const entry = BY_NAME.get(name);
  if (entry === undefined) {
    throw new Error(`no queue topology entry named "${name}"`);
  }
  return entry;
}
