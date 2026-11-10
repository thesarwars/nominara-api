import { Logger } from "@nestjs/common";
import { Worker, type Job, type WorkerOptions } from "bullmq";
import type { Redis } from "ioredis";
import type { ClientBase } from "pg";
import type { Env } from "../../config/env.schema.js";
import { withTenantJob } from "../../tenancy/with-tenant-job.js";
import { withEngineLease, type EngineLeaseOptions } from "../engines/engine-lease.js";
import { createBackoffStrategy } from "./backoff.js";
import { toTenantJob, type QueueJobEnvelope, type TenantScopedPayload } from "./envelope.js";
import { rotatingHmacJobVerifier, type RotatingSigningKeys, type SigningKey } from "./signing.js";
import type { QueueTopologyEntry } from "./topology.js";

// STORY-030 Phase B — the security-critical half of this story.
// system-architecture.md §4: "A worker verifies the signature before any
// set_config call, so a poisoned Valkey entry cannot redirect a worker into
// another tenant (NFR-SEC-04, ISO-11)." `createJobProcessor` is exported
// SEPARATELY from `buildWorker` specifically so
// test/isolation/assertions/iso-11-tampered-job-signature.ts can exercise
// this EXACT function (not a bare with-tenant-job.ts helper standing in for
// it) with a query-counting proxy client and no live BullMQ/Redis at all.

const logger = new Logger("queue-worker");

export type JobProcessor<T = unknown> = (tx: ClientBase, job: Job) => Promise<T>;

// ADR-0003 — a PHASED tenant job, for a handler whose middle is the network (KAD-06: no handler holds a transaction, or the
// pooled connection under it, across an await on an external service).
//
//   prepare(tx)  one SHORT tenant transaction: read what the job needs, decide whether there is anything to do. Committed, and the
//                connection is released, BEFORE `run` starts.
//   run(state)   NO transaction, NO client. This is where fetches, renders and object-store writes happen. It gets only what
//                `prepare` returned and the job's already-verified payload; it cannot read tenant data, because it has no client.
//   commit(tx)   a second SHORT tenant transaction, in the same workspace, that writes the result.
//
// The order that makes it safe is unchanged: the signature is verified FIRST, before any client is acquired, and both
// transactions set the tenant context from that verified payload (`set_config(..., true)`), so neither phase can name a
// workspace of its own. Idempotency under at-least-once delivery is the handler's: `commit` may run for a job that another
// delivery already completed, and must say so by writing nothing.

/** What `prepare` returns to end the job without a `run`/`commit` (nothing to do, or already done). */
export const PHASES_DONE: unique symbol = Symbol("nominara.phases.done");

/** Where a phased job failed, and what the earlier phases had produced by then. */
export interface PhaseFailure<Prepared, Fetched> {
  readonly error: unknown;
  readonly phase: "prepare" | "run" | "commit";
  readonly prepared?: Prepared;
  readonly fetched?: Fetched;
}

/**
 * STORY-195 - what `run` is handed so it can WRITE progress without holding a transaction across its own awaits: `fn` runs in its own short
 * tenant transaction (the same workspace, signature already verified) that commits when `fn` returns. Called as a plain function on one
 * client, it simply runs `fn` on that client.
 */
export type TenantStep = <T>(fn: (tx: ClientBase) => Promise<T>) => Promise<T>;

export interface JobPhases<Prepared, Fetched> {
  prepare(tx: ClientBase, job: Job): Promise<Prepared | typeof PHASES_DONE>;
  /** `step` is optional: a handler with no progress to write ignores it, and a direct caller may omit it. */
  run(prepared: Prepared, job: Job, step?: TenantStep): Promise<Fetched>;
  commit(tx: ClientBase, prepared: Prepared, fetched: Fetched, job: Job): Promise<void>;
  /**
   * Optional. Called when ANY phase throws, in a FRESH tenant transaction (the failed one is rolled back and may be aborted),
   * after the signature was verified. Return true when the failure was settled (the job then ends without throwing, so the queue
   * does not retry or dead-letter it); false to leave the original error to the queue. A hook that throws is ignored: the
   * ORIGINAL error is what the queue sees. The handler decides whether this is the last attempt; the factory does not know.
   */
  recover?(tx: ClientBase, job: Job, failure: PhaseFailure<Prepared, Fetched>): Promise<boolean>;
}

const PHASES: unique symbol = Symbol("nominara.job-phases");

/**
 * Wraps `phases` as a JobProcessor. Called as a plain function (a test, a tool) it composes the three phases on the ONE client
 * it is handed, which is the pre-ADR shape. `createJobProcessor` recognises it and splits the transaction instead.
 */
export function phasedProcessor<Prepared, Fetched>(phases: JobPhases<Prepared, Fetched>): JobProcessor<void> {
  const composed: JobProcessor<void> = async (tx, job) => {
    const prepared = await phases.prepare(tx, job);
    if (prepared === PHASES_DONE) return;
    const fetched = await phases.run(prepared, job, (fn) => fn(tx));
    await phases.commit(tx, prepared, fetched, job);
  };
  return Object.assign(composed, { [PHASES]: phases });
}

/** The phases behind a processor built with `phasedProcessor`, or undefined for an ordinary one. */
export function phasesOf(processor: JobProcessor): JobPhases<unknown, unknown> | undefined {
  return (processor as { [PHASES]?: JobPhases<unknown, unknown> })[PHASES];
}

export interface JobProcessorOptions {
  readonly keys: RotatingSigningKeys;
  /** Acquires the client this job's transaction runs on. Called AFTER signature verification for a tenant-scoped queue — never before. */
  readonly getClient: () => Promise<ClientBase> | ClientBase;
  /**
   * STORY-124 — returns the client `getClient` acquired.
   *
   * Optional, and absent everywhere a test hands over a fake client that
   * has nothing to return. The production wiring (src/worker.ts) supplies
   * it, because there a client comes from a pool and a job that does not
   * give it back leaks a connection per job — a defect that could not
   * exist before this story, since nothing had ever acquired one.
   */
  readonly releaseClient?: (client: ClientBase, failure?: unknown) => void;
  readonly process: JobProcessor;
}

/**
 * Builds the per-job processing function for `entry`. For a tenant-scoped
 * queue, `verify(tenantJob)` is the FIRST executable statement — before
 * `getClient()`, before `withTenantJob`'s own BEGIN/set_config calls, before
 * any query of any kind. A non-tenant-scoped queue
 * (`credit.reconcile`/`maintenance.partition`) carries no signed envelope
 * and calls `process` directly.
 */
export function createJobProcessor(entry: QueueTopologyEntry, options: JobProcessorOptions): (job: Job) => Promise<unknown> {
  const verify = rotatingHmacJobVerifier(options.keys);
  const phases = phasesOf(options.process);
  // A phased job IS two tenant transactions; a queue with no tenant has none to split. Fail at construction, not at the first job.
  if (phases !== undefined && !entry.tenantScoped) {
    throw new Error(`queue "${entry.name}" is not tenant-scoped: a phased processor needs a tenant context for each of its two transactions`);
  }

  // STORY-124 — release on EVERY exit path, including a throwing handler.
  // A job that fails is exactly the job most likely to be retried, so a
  // connection lost here is lost once per attempt, not once per job.
  const release = (client: ClientBase, failure?: unknown): void => options.releaseClient?.(client, failure);

  return async (job: Job): Promise<unknown> => {
    if (!entry.tenantScoped) {
      const client = await options.getClient();
      let failure: unknown;
      try {
        return await options.process(client, job);
      } catch (error) {
        failure = error;
        throw error;
      } finally {
        release(client, failure);
      }
    }

    const envelope = job.data as QueueJobEnvelope<TenantScopedPayload>;
    const tenantJob = toTenantJob(envelope);

    // Rejects a tampered/poisoned envelope here — before any client is even
    // acquired, let alone any context set on one. The try/finally below
    // starts AFTER this line, deliberately: there is nothing to release
    // when nothing was acquired, and moving acquisition up to simplify the
    // shape is the one change ISO-11 exists to prevent.
    verify(tenantJob);

    // ADR-0003: two short tenant transactions around a run that holds neither a transaction nor a connection.
    if (phases !== undefined) {
      let at: PhaseFailure<unknown, unknown> = { error: undefined, phase: "prepare" };
      try {
        const prepared = await inTenantTransaction((tx) => phases.prepare(tx, job));
        if (prepared === PHASES_DONE) return undefined;
        at = { error: undefined, phase: "run", prepared };
        const fetched = await phases.run(prepared, job, inTenantTransaction);
        at = { error: undefined, phase: "commit", prepared, fetched };
        await inTenantTransaction((tx) => phases.commit(tx, prepared, fetched, job));
        return undefined;
      } catch (error) {
        const recover = phases.recover;
        if (recover === undefined) throw error;
        let settled = false;
        try {
          settled = await inTenantTransaction((tx) => recover.call(phases, tx, job, { ...at, error }));
        } catch (recoveryError) {
          // The original error is the one the queue (and the operator) must see; the recovery's own is only named.
          logger.warn({ event: "job.recover_failed", queue: entry.name, error: recoveryError instanceof Error ? recoveryError.name : "unknown" });
        }
        if (!settled) throw error;
        return undefined;
      }
    }

    return inTenantTransaction((tx) => options.process(tx, job));

    // Each call acquires its OWN client AFTER verification and returns it before the next begins; `withTenantJob` verifies again
    // (cheap, and it keeps `withTenantJob` safe to call from anywhere) and sets the context from the verified payload.
    async function inTenantTransaction<T>(fn: (tx: ClientBase) => Promise<T>): Promise<T> {
      const client = await options.getClient();
      let failure: unknown;
      try {
        return await withTenantJob(client, tenantJob, verify, fn);
      } catch (error) {
        failure = error;
        throw error;
      } finally {
        release(client, failure);
      }
    }
  };
}

function adaptBackoffStrategy(entry: QueueTopologyEntry): (attemptsMade: number) => number {
  const strategy = createBackoffStrategy(entry.name);
  return (attemptsMade: number): number => {
    const delay = strategy(attemptsMade);
    // backoff.ts's own contract returns `false` once the ladder is
    // exhausted; BullMQ's real backoffStrategy type has no such sentinel —
    // its documented "stop retrying now" signal is `-1`
    // (bullmq Job.shouldRetryJob: `delay == -1 ? false : true`). `attempts`
    // is already sized to this ladder's exact length (queue-factory.ts's
    // attemptsFor), so BullMQ should never actually call this strategy past
    // the ladder's end — this translation is defense-in-depth, not the
    // normal path.
    return delay === false ? -1 : delay;
  };
}

export interface BuildWorkerOptions extends JobProcessorOptions {
  readonly connection: Redis;
  readonly prefix: string;
  /** Defaults to BullMQ's own default (true). Placeholder workers with no real handler wired yet pass false so no job is ever pulled. */
  readonly autorun?: boolean;
  /** SCANFIX D3 - when set, every job first acquires a per-engine token-bucket lease. */
  readonly engineLease?: EngineLeaseOptions;
}

/** Builds a real BullMQ Worker for `entry`, running every job through `createJobProcessor`'s verify-before-context ordering. */
export function buildWorker(entry: QueueTopologyEntry, options: BuildWorkerOptions): Worker {
  const processor = createJobProcessor(entry, options);

  const workerOptions: WorkerOptions = {
    connection: options.connection,
    prefix: options.prefix,
    concurrency: entry.concurrency,
    autorun: options.autorun ?? true,
    settings: { backoffStrategy: adaptBackoffStrategy(entry) },
  };

  // SCANFIX D3 - when a lease is configured, every job first takes a per-engine token. The lease wraps
  // the processor from OUTSIDE (STORY-031 D17): signature verification inside it is untouched.
  const worker = new Worker(entry.name, options.engineLease ? withEngineLease(processor, options.engineLease) : processor, workerOptions);
  // Never let a connection blip crash the process (unhandled 'error' event)
  // — log and let ioredis's own reconnect logic keep trying.
  worker.on("error", (error) => {
    logger.error(`queue worker "${entry.name}" error: ${error.message}`);
  });
  return worker;
}

type SigningEnv = Pick<
  Env,
  "QUEUE_JOB_SIGNING_KEY" | "QUEUE_JOB_SIGNING_KID" | "QUEUE_JOB_SIGNING_PREVIOUS_KEY" | "QUEUE_JOB_SIGNING_PREVIOUS_KID"
>;

/** Reads the rotating job-signing keys src/config/env.schema.ts validates at boot into signing.ts's RotatingSigningKeys shape. */
export function signingKeysFromEnv(env: SigningEnv): RotatingSigningKeys {
  const current: SigningKey = { kid: env.QUEUE_JOB_SIGNING_KID, key: Buffer.from(env.QUEUE_JOB_SIGNING_KEY, "base64") };
  if (env.QUEUE_JOB_SIGNING_PREVIOUS_KEY && env.QUEUE_JOB_SIGNING_PREVIOUS_KID) {
    return {
      current,
      previous: { kid: env.QUEUE_JOB_SIGNING_PREVIOUS_KID, key: Buffer.from(env.QUEUE_JOB_SIGNING_PREVIOUS_KEY, "base64") },
    };
  }
  return { current };
}
