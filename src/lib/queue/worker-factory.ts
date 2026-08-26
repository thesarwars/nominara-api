import { Logger } from "@nestjs/common";
import { Worker, type Job, type WorkerOptions } from "bullmq";
import type { Redis } from "ioredis";
import type { ClientBase } from "pg";
import type { Env } from "../../config/env.schema.js";
import { withTenantJob } from "../../tenancy/with-tenant-job.js";
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

export interface JobProcessorOptions {
  readonly keys: RotatingSigningKeys;
  /** Acquires the client this job's transaction runs on. Called AFTER signature verification for a tenant-scoped queue — never before. */
  readonly getClient: () => Promise<ClientBase> | ClientBase;
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

  return async (job: Job): Promise<unknown> => {
    if (!entry.tenantScoped) {
      const client = await options.getClient();
      return options.process(client, job);
    }

    const envelope = job.data as QueueJobEnvelope<TenantScopedPayload>;
    const tenantJob = toTenantJob(envelope);

    // Rejects a tampered/poisoned envelope here — before any client is even
    // acquired, let alone any context set on one.
    verify(tenantJob);

    const client = await options.getClient();
    return withTenantJob(client, tenantJob, verify, (tx) => options.process(tx, job));
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

  const worker = new Worker(entry.name, processor, workerOptions);
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
