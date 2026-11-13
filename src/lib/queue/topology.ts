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
  // ⚠ THE SECOND QUEUE §4 DOES NOT CONTAIN (after `audit.verify`), added for the
  // same reason and by the same precedent. STORY-173: an email-code request for an
  // address with no account creates that account `unverified`, and the rows nobody
  // came back for must not accumulate (or stay squatted). The sweep
  // (`workers/rollup/unverified-sweep.ts`) has existed since that story; the owner
  // decided it runs DAILY on this system rather than by hand. A queue of its own
  // rather than folded into `maintenance.partition`, so a DLQ entry or boot line
  // names the job that failed. Not tenant-scoped: `users` is global.
  // Advisory-locked (`locks.ts`): concurrency 1 bounds one Worker instance, not
  // the queue, and two replicas deleting the same rows is pure duplicated cost.
  {
    name: "identity.sweep_unverified",
    producer: "cron daily (STORY-173; not in §4)",
    workerGroup: "rollup",
    concurrency: 1,
    retry: { delaysMs: doubling(3) },
    priority: 9,
    idempotencyKeyPattern: "unvsweep:{yyyy_mm_dd}",
    tenantScoped: false,
  },
  // ⚠ THE THIRD QUEUE §4 DOES NOT CONTAIN (after `audit.verify` and
  // `identity.sweep_unverified`), added by the same precedent. NEW-C-15 /
  // STORY-054 AC4: brand presence on a cited domain is verified by FETCHING the
  // cited URL through the guarded fetcher and matching it, cached 30 days. §4
  // allocates no queue to that fetch, and it may not run on a request path
  // (KAD-06) nor inside the rollup transaction, which reads only this database.
  // The `crawl` group because it is an outbound fetcher of third-party pages,
  // like `crawl.audit`; a queue of its own so a DLQ entry names the job that
  // failed. Tenant-scoped (signed payload, RLS context). Its producer is
  // `rollup.metric_daily`, which enqueues it after its own transaction commits.
  // STORY-066 AC8 adds a second producer: `TasksService.completeTask` enqueues
  // one job per completed authority task (payload `taskId`), after its commit,
  // keyed `srcver:seeded:{task}:{completed_at_ms}` — the pattern below is the rollup's key.
  // STORY-055 (owner decision 30) adds the producer that matters now: `TasksService.completeTask` enqueues one job per SUBMITTED
  // contribution URL of a seeding task (payload `taskId` + `submissionId`), after its commit, keyed `taskverify:{submission_event_id}`
  // - the id of the task's `verification_submitted` event, so the key is per SUBMISSION (a resubmission after a failed check is a new
  // job). A resubmit while the check is still pending re-enqueues the SAME key (a 409 for the caller), which is how a submission whose
  // first enqueue failed recovers. The pattern below is still the rollup's; this job's key is `taskverify:{submission}`. The job
  // never retries a fetch error: it answers `unreachable` and leaves the task in review. It publishes `task.moved` and audits.
  // The `taskId`-only mode above has no producer any more and is kept for jobs already queued at deploy time.
  // Phased (ADR-0003): no transaction is held across either kind of fetch.
  {
    name: "source.verify_presence",
    producer: "API (task completion, STORY-066), rollup (STORY-054; not in §4)",
    workerGroup: "crawl",
    concurrency: 2,
    retry: { delaysMs: doubling(2) },
    priority: 7,
    idempotencyKeyPattern: "srcver:{project}:{yyyy_mm_dd}",
    tenantScoped: true,
  },
  // ⚠ THE FOURTH QUEUE §4 DOES NOT CONTAIN, added by the same precedent. NEW-D-7 / owner decision 4 of
  // 2026-10-08: an auto top-up charges a saved card, which may never happen on a request path (KAD-06). A
  // debit that leaves a workspace below its threshold enqueues one signed tenant job (the credit interceptor,
  // after commit); the worker verifies the signature before any context is set, then
  // the auto-top-up service's `trigger` evaluates and charges. Tenant-scoped, the `rollup` group with the other
  // billing-adjacent workers. The ladder is short because `trigger` is idempotent under redelivery (a
  // conditional claim under the wallet lock) and a top-up that never ran is simply asked for again by the
  // next debit; the idempotency key is one job per workspace per UTC minute.
  {
    name: "billing.auto_topup",
    producer: "credit interceptor, after a debit below the threshold (NEW-D-7; not in §4)",
    workerGroup: "rollup",
    concurrency: 2,
    retry: { delaysMs: doubling(2) },
    priority: 3,
    idempotencyKeyPattern: "autotopup:{workspace}:{yyyy_mm_dd_hh_mm}",
    tenantScoped: true,
  },
  // ⚠ A QUEUE §4 DOES NOT CONTAIN, added by the same precedent. STORY-021 / EC-15: after an ownership transfer commits,
  // the Stripe customer keeps its identity (same customer, same subscription, same invoices) and only its billing email
  // is re-pointed to the new owner. A Stripe call may never be made on a request path (KAD-06), so the accept enqueues
  // one signed tenant job after commit. The handler reads the LIVE owner and customer — the payload carries ids, never
  // an address — so a redelivery, or a job that outlived a second transfer, converges on the current owner instead of
  // writing a stale one. Same `rollup` group as the other billing-adjacent workers; setting the same email twice is a
  // no-op at Stripe, so the ordinary short ladder is safe under redelivery.
  {
    name: "billing.customer_email",
    producer: "ownership transfer accept, after commit (STORY-021; not in §4)",
    workerGroup: "rollup",
    concurrency: 2,
    retry: { delaysMs: doubling(3) },
    priority: 6,
    idempotencyKeyPattern: "custmail:{workspace}:{owner}:{transfer}",
    tenantScoped: true,
  },
  // ⚠ A QUEUE §4 DOES NOT CONTAIN, added by the same precedent and approved by the owner (STORY-077, decision 2026-10-23):
  // the downgrade pause/resume email must be retried on failure and never sent twice. The plan writer records each email
  // in `downgrade_notices` inside its transaction and enqueues one signed tenant job per row after the commit; the
  // handler is PHASED (ADR-0003: the send runs with no transaction), sends with a provider idempotency key derived from
  // the row, and marks it sent. A failed send fails the job down this ladder; a sent row is never sent again. Keyed by
  // the Stripe event id (or, for plan:set, the ticket and the change's entitlement version) and the kind, hashed. Same
  // `rollup` group as the other billing jobs. THE LADDER IS SHORT (about a minute); a notice still unsent after it
  // is re-enqueued hourly, for up to 23 hours, by the relay (lib/billing/downgrade-notice-relay.ts) under an
  // hour-suffixed key of the same pattern, which keeps every re-send inside Resend's 24-hour idempotency window.
  {
    name: "billing.downgrade_notice",
    producer: "Stripe webhook cut-over and plan:set, after commit (STORY-077; not in §4)",
    workerGroup: "rollup",
    concurrency: 2,
    retry: { delaysMs: doubling(5) },
    priority: 6,
    idempotencyKeyPattern: "dgnotice:{workspace}:{request}:{kind}",
    tenantScoped: true,
  },
  // ⚠ A QUEUE §4 DOES NOT CONTAIN, added by the same precedent and approved by the owner (decision 100(c), 2026-11-12): the full-data export a
  // customer may take while a retention-shortening purge is pending (STORY-185). ONE job per export request: it reads every raw object the purge
  // will remove from the object store, so it runs in the `report` group (the heavy builds), concurrency 1, and is PHASED (ADR-0003): short tenant
  // reads page by page, the upload with no transaction open, the project's purge lock (EC-40) held around each project's reads only. A failed
  // attempt retries down this ladder; the last attempt marks the export failed so the owner can ask again. 0 credits.
  {
    name: "billing.retention_export",
    producer: "POST /v1/billing/retention-export, after commit (STORY-185, decision 100(c); not in §4)",
    workerGroup: "report",
    concurrency: 1,
    retry: { delaysMs: doubling(3) },
    priority: 8,
    idempotencyKeyPattern: "retexp:{workspace}:{export}",
    tenantScoped: true,
  },
  // ⚠ A QUEUE §4 DOES NOT CONTAIN, added by the same precedent and approved by the owner (decision 83(a), 2026-11-09): deleting a
  // workspace must stop its Stripe subscription renewing. The deletion request commits, then enqueues ONE signed tenant job; the
  // handler sets `cancel_at_period_end` (no immediate cancel, no refund) with no transaction open (KAD-06 / ADR-0003). Setting a
  // boolean is idempotent, so redelivery is safe; the ladder is long (about 8.5 minutes) because this is money, and a job that
  // still fails lands in the DLQ, which alerts, with the 30-day grace left to replay it before the purge. One request per
  // workspace (a `pending_deletion` workspace refuses a second), hence the key.
  {
    name: "billing.cancel_on_deletion",
    producer: "workspace deletion request, after commit (decision 83(a); not in §4)",
    workerGroup: "rollup",
    concurrency: 2,
    retry: { delaysMs: doubling(8) },
    priority: 6,
    idempotencyKeyPattern: "delcancel:{workspace}",
    tenantScoped: true,
  },
  // ⚠ THE FIFTH QUEUE §4 DOES NOT CONTAIN, added by the same precedent. STORY-076 AC4 / STORY-071 AC10: purchased
  // credits expire FIFO twelve months after purchase (`plans-and-entitlements.md` §5) and `credit_daily_counters` rows
  // older than 35 days are purged nightly (`schemas/billing-and-credits.md`). `expireCredits` and `purgeDailyCounters`
  // were built and tested and had no caller. ONE queue for both because both need the same privileged cross-tenant
  // connection; they stay independent steps in the handler. Not tenant-scoped (it discovers across workspaces, then
  // writes each one's expiry inside that workspace's own tenant context). Advisory-locked (`locks.ts`): concurrency 1
  // bounds one Worker instance, not the queue. Idempotent under redelivery — the expiry is a recomputation, not an
  // increment — so the ladder is the ordinary three.
  {
    name: "credit.housekeeping",
    producer: "cron daily (STORY-076 AC4, STORY-071 AC10; not in §4)",
    workerGroup: "rollup",
    concurrency: 1,
    retry: { delaysMs: doubling(3) },
    priority: 9,
    idempotencyKeyPattern: "credithk:{yyyy_mm_dd}",
    tenantScoped: false,
  },
  // ⚠ THE SIXTH, AND THE ONE THAT DELETES CUSTOMER DATA. STORY-077 R4 / STORY-013: `runDailyPurgeCycle` hard-deletes
  // projects 30 days after a soft delete and executes workspace deletions past their grace period
  // (`data-model.md` §7). The queue and its schedule exist so the cadence is declared in one place, but THE HANDLER DOES
  // NOTHING UNLESS `RETENTION_PURGE_ENABLED=true`, and that flag is off by default — see
  // `handlers/retention-purge.handler.ts` for why. Not tenant-scoped (cross-tenant discovery, owner connection).
  {
    name: "retention.purge",
    producer: "cron daily (STORY-077 R4, data-model.md §7; not in §4)",
    workerGroup: "rollup",
    concurrency: 1,
    retry: { delaysMs: doubling(3) },
    priority: 9,
    idempotencyKeyPattern: "retpurge:{yyyy_mm_dd}",
    tenantScoped: false,
  },
  // ⚠ THE SIXTH-AND-LATER QUEUE §4 DOES NOT CONTAIN, added by the same precedent. STORY-048 AC7 / OWNER DECISION
  // 2026-10-19 (adding a queue to the topology is a specification change, and this one is approved): a verified
  // domain is re-verified daily, and one that stops verifying loses full scope with a notification. The DNS and
  // HTTPS checks are network calls that may never run on a request path (KAD-06). Crawl group, with the other
  // outbound fetchers. NOT tenant-scoped: the tick has no workspace to name, so discovery runs cross-tenant on the
  // owner connection and each outcome is applied in ONE tenant's context as the runtime role (`verification/reverify.ts`).
  // Advisory-locked single-flight; a domain checked inside the minimum interval is skipped, which is the idempotency.
  {
    name: "domain.reverify",
    producer: "cron daily (STORY-048 AC7; not in §4)",
    workerGroup: "crawl",
    concurrency: 1,
    retry: { delaysMs: doubling(3) },
    priority: 9,
    idempotencyKeyPattern: "domreverify:{yyyy_mm_dd}",
    tenantScoped: false,
  },
  // ⚠ AN ADDED QUEUE §4 DOES NOT CONTAIN, by the same precedent. STORY-064 AC5: a dismissed or snoozed task returns when its
  // `resurface_at` passes, with an audited system 'reopened' event (a read cannot write one, so a read-time rule would break the
  // timeline). The mechanism is a workspace-agnostic scheduled sweep, NOT a step of the rollup: a rollup only visits a project on
  // the days it rolls up, so a quiet project's dismissed tasks would never return. Rollup group, with the other owner-connection
  // ticks. NOT tenant-scoped: the tick has no workspace to name, so discovery runs cross-tenant on the owner connection and each
  // reopen is applied in ONE tenant's context as the runtime role (`rollup/resurface-dismissed-tasks.ts`). Advisory-locked
  // single-flight; a second run finds nothing due, which is the idempotency.
  {
    name: "task.resurface",
    producer: "cron daily (STORY-064 AC5; not in §4)",
    workerGroup: "rollup",
    concurrency: 1,
    retry: { delaysMs: doubling(3) },
    priority: 9,
    idempotencyKeyPattern: "taskresurf:{yyyy_mm_dd}",
    tenantScoped: false,
  },
  // ⚠ NOT FROM §4 — STORY-013 AC6 / AC14 / AC16. The nightly integrity tick: the orphan scan ("pages on non-zero"), the purge-failure
  // check ("alerts and blocks the next release train if unresolved") and the vector-recall check ("checked nightly"). All three were
  // reachable only from hand-run scripts. A queue of its own, and not folded into `maintenance.partition`, because that tick is
  // deliberately cheap and DDL-only (STORY-142) while the recall check runs forced sequential-scan exact queries; a DLQ entry should
  // also name the check that paged. READ-ONLY: no DDL, no REINDEX. Not tenant-scoped (cross-tenant by definition, owner connection).
  // Advisory-locked single-flight (`locks.ts`).
  {
    name: "maintenance.integrity",
    producer: "cron daily (STORY-013; not in §4)",
    workerGroup: "rollup",
    concurrency: 1,
    retry: { delaysMs: doubling(3) },
    priority: 9,
    idempotencyKeyPattern: "integrity:{yyyy_mm_dd}",
    tenantScoped: false,
  },
  // ⚠ AN ADDED QUEUE §4 DOES NOT CONTAIN. STORY-180 r5 (owner decision 60 (b)): the nightly deletion of stored report files whose 7-day
  // life has ended and of half-uploaded ones (`reports/artifact-cleanup.ts`: object first, then the row, never storage I/O in a transaction).
  // Rollup group, with the other owner-connection ticks. NOT tenant-scoped: the tick has no workspace to name, so discovery runs cross-tenant
  // on the owner connection and each workspace is cleaned in ONE tenant's context as the runtime role. Advisory-locked single-flight; a second
  // run finds nothing due, which is the idempotency.
  {
    name: "report.cleanup",
    producer: "cron daily (STORY-180 r5, owner decision 60; not in §4)",
    workerGroup: "rollup",
    concurrency: 1,
    retry: { delaysMs: doubling(3) },
    priority: 9,
    idempotencyKeyPattern: "reportclean:{yyyy_mm_dd}",
    tenantScoped: false,
  },
  // NOT IN §4 EITHER - STORY-073 AC4 / NFR-CRD-03: "a nightly job asserts equality and pages on mismatch". `verifyAllWallets`
  // (workers/rollup/credit-verify.ts) was complete and ran only as `pnpm credits:verify`. A queue of its own, not a
  // `credit.housekeeping` step: a mismatch must be ONE dead-letter entry naming the verifier, never retried beside the idempotent
  // expiry. Not tenant-scoped (cross-tenant by definition); advisory-locked as `credit.reconcile` is.
  {
    name: "credit.verify",
    producer: "cron daily (STORY-073 AC4, NFR-CRD-03; not in §4)",
    workerGroup: "rollup",
    concurrency: 1,
    retry: { delaysMs: doubling(3) },
    priority: 9,
    idempotencyKeyPattern: "creditver:{yyyy_mm_dd}",
    tenantScoped: false,
  },
  // NOT IN §4 EITHER - STORY-176 / OWNER DECISION 93 (2026-11-09). The cross-workspace benchmark (`platform_metrics`) was recomputed inside every tenant's own
  // rollup transaction, holding a category-wide advisory lock until that tenant committed, and a category override recomputed it at once (so two workspaces of
  // one attacker could difference the figures). It is now a nightly batch of its own: category membership moves here and only here, then each category is
  // recomputed in its own short transaction. Not tenant-scoped (no workspace to name; the cross-tenant read is inside two SECURITY DEFINER functions the
  // runtime role may execute). One job per UTC day (the idempotency key), advisory-locked single-flight. A queue of its own so a DLQ entry names the job.
  {
    name: "rollup.category_benchmark",
    producer: "cron daily (STORY-176, decision 93; not in §4)",
    workerGroup: "rollup",
    concurrency: 1,
    retry: { delaysMs: doubling(3) },
    priority: 9,
    idempotencyKeyPattern: "catbench:{yyyy_mm_dd}",
    tenantScoped: false,
  },
  // NOT IN §4 EITHER - STORY-045 / OWNER DECISION 95(a) (2026-11-10): prompt generation is a background job. The pass's two external calls (the
  // naturaliser, a model; and vector dedupe's embedder) may not run in a request handler (NFR-ARCH-01) nor under a transaction (NFR-ARCH-04, ADR-0003),
  // and the generate route's ambient transaction made both impossible. The route records a pending `prompt_generations` row and answers 202; this
  // queue runs the pass. Crawl group, with the other jobs that call out (`crawl.discover` already embeds in its no-transaction `run` phase); priority 1
  // because onboarding shows a "generating" state and a person is waiting. Tenant-scoped and signed. One job per generation (the idempotency key).
  {
    name: "prompt.generate",
    producer: "API (STORY-045 decision 95a; not in §4)",
    workerGroup: "crawl",
    concurrency: 3,
    retry: { delaysMs: doubling(2) },
    priority: 1,
    idempotencyKeyPattern: "promptgen:{generation}",
    tenantScoped: true,
  },
  // STORY-075 AC11 / owner decision 2026-10-28 section 100(e): the nightly Stripe-versus-local drift check. ALERT ONLY, it never writes
  // (`lib/billing/stripe-drift.ts`). Stripe calls may not be made on a request path (KAD-06), so it is a cron job; not tenant-scoped (the tick
  // names no workspace; discovery is cross-tenant on the owner connection). Idempotent: it reads and counts.
  {
    name: "billing.stripe_drift",
    producer: "cron daily (STORY-075 AC11, decision 2026-10-28 section 100(e); not in §4)",
    workerGroup: "rollup",
    concurrency: 1,
    retry: { delaysMs: doubling(3) },
    priority: 9,
    idempotencyKeyPattern: "stripedrift:{yyyy_mm_dd}",
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
