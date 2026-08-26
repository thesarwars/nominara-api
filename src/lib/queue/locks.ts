import type { ClientBase } from "pg";

// STORY-030 Phase C — system-architecture.md §4 documents three queues with
// an advisory lock beyond their bare BullMQ concurrency number:
// `rollup.metric_daily` ("serialised per project by lock"), `topic.cluster`
// ("advisory-locked per project"), `credit.reconcile` ("advisory-locked",
// global — no per-project scope). Same
// `pg_advisory_xact_lock(hashtextextended(key, 0))` primitive already used by
// oauth.service.ts / email-otp.service.ts / audit-chain.service.ts:
// transaction-scoped, released automatically at COMMIT/ROLLBACK — never
// leaked by a crashed worker holding a session-level lock forever. The
// caller must already have an open transaction (`BEGIN`) on `client` before
// calling any function here, same precondition as those existing call sites.
//
// Key namespacing here is deliberately stricter than all three precedents:
// oauth.service.ts/email-otp.service.ts prefix their keys
// (`oauth_credential:...`, `email_otp:...`), but audit-chain.service.ts locks
// on a BARE workspaceId with no prefix at all — every key built below is
// always `queue-lock:<queueName>:...`, so it can never collide with that one
// unprefixed caller (code-review note: don't cite audit-chain.service.ts as
// evidence this codebase already namespaces consistently — it doesn't).
//
// Why credit.reconcile needs this in addition to its documented concurrency
// of 1: BullMQ's `concurrency` option bounds how many jobs ONE Worker
// instance runs at once — it is not a queue-wide limit. A horizontally
// scaled deployment runs more than one process for the "rollup" worker
// group (this queue's workerGroup, per topology.ts), and each process's
// Worker independently pulls up to its own concurrency ceiling. Two
// replicas at concurrency:1 each can still run two credit.reconcile jobs at
// the same instant, one per replica — BullMQ's own concurrency knob cannot
// see across process boundaries. The advisory lock is what makes
// reconciliation single-flight across the whole fleet, not just within one
// process.

/** `SELECT pg_advisory_xact_lock(...)` on `key` — blocks until acquired, auto-released at this transaction's COMMIT/ROLLBACK. */
export async function acquireAdvisoryXactLock(client: ClientBase, key: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
}

/** Per-project serialization key for a queue documented as locked "per project" (rollup.metric_daily, topic.cluster). Namespaced by queue name so two queues' per-project locks never collide with each other. */
export function projectQueueLockKey(queueName: string, projectId: string): string {
  return `queue-lock:${queueName}:${projectId}`;
}

/** Global serialization key for a queue documented as advisory-locked with no per-project scope (credit.reconcile) — every job for this queue, across every worker process, contends for the SAME key. */
export function globalQueueLockKey(queueName: string): string {
  return `queue-lock:${queueName}:global`;
}

/** Runs `fn` while holding `queueName`'s per-`projectId` advisory lock — `client` must already be inside an open transaction. */
export async function withProjectQueueLock<T>(
  client: ClientBase,
  queueName: string,
  projectId: string,
  fn: () => Promise<T>,
): Promise<T> {
  await acquireAdvisoryXactLock(client, projectQueueLockKey(queueName, projectId));
  return fn();
}

/** Runs `fn` while holding `queueName`'s global advisory lock — `client` must already be inside an open transaction. */
export async function withGlobalQueueLock<T>(client: ClientBase, queueName: string, fn: () => Promise<T>): Promise<T> {
  await acquireAdvisoryXactLock(client, globalQueueLockKey(queueName));
  return fn();
}
