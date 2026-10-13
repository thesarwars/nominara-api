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

/**
 * ⚠ LOCK-ORDERING RULE, and it is not enforceable by the deadlock detector.
 * Never acquire a key from this file inside a transaction that already holds
 * a `credit_wallets` row lock. `credit.reconcile` holds its advisory lock on
 * one backend (`discovery`) while a DIFFERENT backend (the `work` pool) takes
 * the wallet row locks, so a cycle between the two is invisible to Postgres —
 * it cannot see across connections it does not know are related, and the
 * result is a permanent hang rather than a detected deadlock. Latent today:
 * no caller does this. Cheap to keep that way.
 */

/** Runs `fn` while holding `queueName`'s global advisory lock — `client` must already be inside an open transaction. */
export async function withGlobalQueueLock<T>(client: ClientBase, queueName: string, fn: () => Promise<T>): Promise<T> {
  await acquireAdvisoryXactLock(client, globalQueueLockKey(queueName));
  return fn();
}

// ─────────────────────────────────────────────────────────────────────────
// STORY-141 — the SESSION-scoped variant, added for `credit.reconcile`.
//
// ⚠ THIS DELIBERATELY BREAKS THE PREFERENCE THIS FILE'S HEADER STATES, so
// read the reason before reaching for it. Everything above is
// `pg_advisory_xact_lock` because a transaction-scoped lock cannot be leaked:
// it releases at COMMIT or ROLLBACK, so a worker that dies mid-hold cannot
// strand it. That is the right default and it stays the default.
//
// It cannot serve the reconciler, and the obstacle is structural rather than
// stylistic. An xact lock is held for exactly as long as its transaction, so
// covering the orphan scan with one means running the whole scan inside a
// single transaction — and `credit-reconcile.handler.ts` and `reconcile.ts`
// both explain at length why that is wrong: the reconciler opens ONE
// TRANSACTION PER ORPHANED RESERVATION on purpose, because a single
// transaction across the estate would hold a row lock on every wallet it
// touched for the length of the run, and one unreleasable orphan would roll
// back every release that had already succeeded. Acquiring the lock in its
// own short transaction does not work either — it would be released by that
// transaction's COMMIT, before the scan it is meant to guard begins.
//
// So the lock has to outlive a transaction, which means session scope. The
// header's leak concern is answered by WHERE it is held rather than by hope:
// the reconciler's `discovery` connection is opened per job by `connect()`,
// is never pooled, and is ended in a `finally`. If the worker dies, that
// backend terminates, and Postgres releases every session lock held by a
// terminated backend. There is no path on which this outlives the process
// that took it.
//
// ⚠ AND IT IS A TRY-LOCK, NOT A WAIT. `pg_advisory_lock` would queue the
// ticks: a scan that outruns the ten-minute cadence would leave each
// replica's next tick blocked on a privileged connection, and the waiter
// would then run a scan that finds almost nothing, having paid for the wait.
// A periodic sweep should never queue behind itself. "What is still open
// now" is not a question about a window — a skipped tick loses nothing,
// because the next one asks the same question ten minutes later.

/**
 * `SELECT pg_try_advisory_lock(...)` on `key`. Returns false IMMEDIATELY if
 * another session holds it — never waits.
 *
 * ⚠ `client` must be a dedicated, non-pooled connection, and the caller must
 * release it (or end the connection) on every exit path. Taking this on a
 * pooled client would hand the lock back to the pool still held.
 *
 * ⚠ AND THE *URL* MUST BE DIRECT, NOT THE POOLER — a separate hazard from a
 * pooled client object, and unrecoverable rather than merely untidy. Under
 * pgBouncer's transaction pooling the lock lands on a server connection that
 * is handed to the next client at the next transaction boundary: it is
 * stranded on a backend nobody owns, and a later `pg_advisory_unlock` may not
 * even reach it. `DATABASE_URL` is the direct connection and
 * `DATABASE_URL_POOLED` is the pooler. Since STORY-141 AC 8 `env.schema.ts`
 * refuses to boot when `DATABASE_URL` carries the pooler's documented port
 * (6432) or service host (`pgbouncer`); a pooler reachable on any other
 * address cannot be recognised from the URL. Same family as `KAD-03`.
 *
 * ⚠ IT IS RE-ENTRANT AND REF-COUNTED PER SESSION. Calling it twice on the
 * same connection returns true both times and increments a counter; the first
 * `pg_advisory_unlock` returns true while the lock is STILL held against other
 * sessions. Exactly one release per acquisition. This is harmless while every
 * caller opens a fresh connection per run, and becomes a slow wedge the moment
 * one hoists the connection to a longer scope — the accumulated refcount never
 * reaches zero and the reconciler stops, far from the change that caused it.
 */
export async function tryAdvisorySessionLock(client: ClientBase, key: string): Promise<boolean> {
  const result = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked", [key]);
  return result.rows[0]?.locked === true;
}

/**
 * Releases a lock taken by `tryAdvisorySessionLock` on this same connection.
 *
 * Returns false when this session did not hold it — which is a bug at the
 * call site rather than a condition to handle, so callers log it rather than
 * branching on it. Ending the connection releases it regardless; this exists
 * so the release is visible in the code and not merely a side effect of
 * cleanup.
 */
export async function releaseAdvisorySessionLock(client: ClientBase, key: string): Promise<boolean> {
  const result = await client.query<{ released: boolean }>("SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS released", [key]);
  return result.rows[0]?.released === true;
}
