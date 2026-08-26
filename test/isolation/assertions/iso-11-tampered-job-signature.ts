import { createHmac, randomBytes } from "node:crypto";
import type { Job } from "bullmq";
import type { ClientBase } from "pg";
import { withTenantJob, hmacSha256JobVerifier, type TenantJob } from "../../../src/tenancy/with-tenant-job.js";
import { withTenantContext } from "../../../src/tenancy/tenant-context.js";
import { SYSTEM_ACTOR_ID } from "../../../src/tenancy/constants.js";
import { JobSignatureError } from "../../../src/tenancy/errors.js";
import { signQueueJobPayload, toTenantJob, type QueueJobEnvelope, type TenantScopedPayload } from "../../../src/lib/queue/envelope.js";
import { rotatingHmacJobVerifier, type RotatingSigningKeys } from "../../../src/lib/queue/signing.js";
import { createJobProcessor, type JobProcessorOptions } from "../../../src/lib/queue/worker-factory.js";
import { QUEUE_TOPOLOGY, type QueueTopologyEntry } from "../../../src/lib/queue/topology.js";
import { NOOP_REVERT, type Breaker } from "../support/breakers.js";

// security-and-tenancy.md §10 ISO-11 / STORY-012 T17 — a tampered job
// payload is rejected BEFORE any context call. No database connection is
// needed at all for the assertion itself: a recording client PROXY counts
// every `.query()` call, and the assertion's whole point is that count stays
// ZERO — verification runs before BEGIN, before set_config, before anything.
interface RecordingProxy {
  readonly client: ClientBase;
  readonly state: { queryCalls: number };
}

function recordingClientProxy(): RecordingProxy {
  const state = { queryCalls: 0 };
  const client = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "query") {
          return (..._args: unknown[]) => {
            state.queryCalls += 1;
            return Promise.resolve({ rows: [], rowCount: 0 });
          };
        }
        return undefined;
      },
    },
  ) as ClientBase;
  return { client, state };
}

function canonicalKey(): Buffer {
  return Buffer.from("iso-11-test-queue-key");
}

function sign(data: Record<string, unknown>, key: Buffer): string {
  return createHmac("sha256", key).update(JSON.stringify(sortKeys(data))).digest("hex");
}
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) out[k] = sortKeys((value as Record<string, unknown>)[k]);
    return out;
  }
  return value;
}

/** Same shape as withTenantJob — lets the breaker below swap in a deliberately misordered variant. */
type WithTenantJobFn = typeof withTenantJob;

async function expectRejectedBeforeAnyQuery(job: TenantJob, key: Buffer, label: string, run: WithTenantJobFn): Promise<void> {
  const proxy = recordingClientProxy();
  const verify = hmacSha256JobVerifier(key);
  let rejected = false;
  try {
    await run(proxy.client, job, verify, async () => "should never run");
  } catch (error) {
    if (!(error instanceof JobSignatureError)) {
      throw new Error(`ISO-11 (${label}): expected JobSignatureError, got ${(error as Error).name}: ${(error as Error).message}`, {
        cause: error,
      });
    }
    rejected = true;
  }
  if (!rejected) {
    throw new Error(`ISO-11 (${label}): withTenantJob did NOT reject a tampered payload`);
  }
  if (proxy.state.queryCalls !== 0) {
    throw new Error(`ISO-11 (${label}): ${proxy.state.queryCalls} query() call(s) occurred BEFORE the signature was verified`);
  }
}

/**
 * `run` defaults to the real withTenantJob. The breaker below passes in
 * `withTenantJobVerifyAfterContext` instead of stubbing a different
 * assertion, so the SAME checks (including the queryCalls-must-be-zero one)
 * run against the broken ordering — the failure that fires is this
 * function's own, not a hand-rolled substitute.
 */
async function assertIso11WithTenantJobLevel(run: WithTenantJobFn = withTenantJob): Promise<void> {
  const key = canonicalKey();
  const data = { workspaceId: "018bcfe5-0000-7000-8000-000000000001" };
  const validSignature = sign(data, key);

  // 1. Tampered payload (valid HEX signature, but for a DIFFERENT payload).
  await expectRejectedBeforeAnyQuery(
    { data: { ...data, workspaceId: "018bcfe5-0000-7000-8000-000000000002" }, signature: validSignature },
    key,
    "tampered payload",
    run,
  );

  // 2. Non-hex signature.
  await expectRejectedBeforeAnyQuery({ data, signature: "not-hex-at-all!!" }, key, "non-hex signature", run);

  // 3. Wrong-length signature (valid hex, wrong length).
  await expectRejectedBeforeAnyQuery({ data, signature: randomBytes(16).toString("hex") }, key, "wrong-length signature", run);
}

/**
 * `run` defaults to the real withTenantJob. This is BOTH: (a) the
 * with-tenant-job.ts PRIMITIVE-level check (unchanged since STORY-012), and
 * (b) the REAL production path — worker-factory.ts's createJobProcessor,
 * wired to the real rotatingHmacJobVerifier — so a regression in EITHER
 * layer fails this one assertion. (b) is the load-bearing proof: it is what
 * an actual worker process runs.
 */
export async function assertIso11TamperedJobRejectedPreContext(run: WithTenantJobFn = withTenantJob): Promise<void> {
  await assertIso11WithTenantJobLevel(run);
  await assertIso11WorkerFactoryProcessorRejectsBeforeContext();
}

// --- The REAL production path: worker-factory.ts's createJobProcessor -----
// Everything above proves the ORDERING PROPERTY at the with-tenant-job.ts
// primitive's level. This section proves the SAME property holds in the
// actual code every worker runs: src/lib/queue/worker-factory.ts's
// createJobProcessor, wired to the REAL rotatingHmacJobVerifier (which
// dispatches on `job.data.kid` — see signing.ts) rather than a single-key
// hmacSha256JobVerifier stand-in. This is the load-bearing proof that
// signature verification precedes context in the code that actually ships.

const ISO_11_TENANT_SCOPED_ENTRY: QueueTopologyEntry = (() => {
  const entry = QUEUE_TOPOLOGY.find((candidate) => candidate.name === "capture.execute");
  if (!entry) {
    throw new Error('ISO-11: fixture bug — QUEUE_TOPOLOGY no longer has a queue named "capture.execute"');
  }
  return entry;
})();

function iso11RotatingKeys(): RotatingSigningKeys {
  return { current: { kid: "iso-11-worker-factory-kid", key: canonicalKey() } };
}

/** Same shape as createJobProcessor — lets the breaker below swap in a deliberately misordered variant. */
type CreateJobProcessorFn = typeof createJobProcessor;

async function expectProcessorRejectedBeforeAnyContextCall(
  job: Job,
  label: string,
  buildProcessor: CreateJobProcessorFn,
): Promise<void> {
  const proxy = recordingClientProxy();
  let getClientCalls = 0;
  const options: JobProcessorOptions = {
    keys: iso11RotatingKeys(),
    getClient: () => {
      getClientCalls += 1;
      return proxy.client;
    },
    process: async () => "should never run",
  };
  const processor = buildProcessor(ISO_11_TENANT_SCOPED_ENTRY, options);

  let rejected = false;
  try {
    await processor(job);
  } catch (error) {
    if (!(error instanceof JobSignatureError)) {
      throw new Error(
        `ISO-11 (worker-factory, ${label}): expected JobSignatureError, got ${(error as Error).name}: ${(error as Error).message}`,
        { cause: error },
      );
    }
    rejected = true;
  }
  if (!rejected) {
    throw new Error(`ISO-11 (worker-factory, ${label}): createJobProcessor did NOT reject a tampered payload`);
  }
  if (getClientCalls !== 0) {
    throw new Error(`ISO-11 (worker-factory, ${label}): getClient() was called ${getClientCalls} time(s) BEFORE the signature was verified`);
  }
  if (proxy.state.queryCalls !== 0) {
    throw new Error(`ISO-11 (worker-factory, ${label}): ${proxy.state.queryCalls} query() call(s) occurred BEFORE the signature was verified`);
  }
}

function envelopeJob(envelope: QueueJobEnvelope<TenantScopedPayload>): Job {
  return { data: envelope } as unknown as Job;
}

/**
 * `buildProcessor` defaults to the real createJobProcessor. The breaker
 * below passes in a deliberately misordered variant, so the SAME checks
 * (including "getClient()/query() must never run before rejection") run
 * against the broken ordering in worker-factory.ts's own shape.
 */
export async function assertIso11WorkerFactoryProcessorRejectsBeforeContext(buildProcessor: CreateJobProcessorFn = createJobProcessor): Promise<void> {
  const keys = iso11RotatingKeys();
  const goodEnvelope = signQueueJobPayload(
    { workspaceId: "018bcfe5-0000-7000-8000-000000000003", kid: keys.current.kid },
    keys.current.key,
  );

  // 1. Tampered payload (valid signature, but for a DIFFERENT workspaceId than the one in `data`).
  await expectProcessorRejectedBeforeAnyContextCall(
    envelopeJob({ payload: { ...goodEnvelope.payload, workspaceId: "018bcfe5-0000-7000-8000-000000000004" }, signature: goodEnvelope.signature }),
    "tampered payload",
    buildProcessor,
  );

  // 2. A kid matching neither the configured current nor previous key.
  await expectProcessorRejectedBeforeAnyContextCall(
    envelopeJob({ payload: { ...goodEnvelope.payload, kid: "some-unrecognized-kid" }, signature: goodEnvelope.signature }),
    "unrecognized kid",
    buildProcessor,
  );

  // 3. Non-hex signature.
  await expectProcessorRejectedBeforeAnyContextCall(
    envelopeJob({ payload: goodEnvelope.payload, signature: "not-hex-at-all!!" }),
    "non-hex signature",
    buildProcessor,
  );

  // 4. Wrong-length signature (valid hex, wrong length).
  await expectProcessorRejectedBeforeAnyContextCall(
    envelopeJob({ payload: goodEnvelope.payload, signature: randomBytes(16).toString("hex") }),
    "wrong-length signature",
    buildProcessor,
  );
}

/**
 * Deliberately broken ordering, at worker-factory.ts's own level: acquires
 * the client and opens the context-carrying transaction FIRST, verifying
 * only from INSIDE it — exactly "verification ordered after context" in the
 * actual code every worker runs, not just in the with-tenant-job.ts
 * primitive it's built on.
 */
const createJobProcessorVerifyAfterContext: CreateJobProcessorFn = (entry, options) => {
  const verify = rotatingHmacJobVerifier(options.keys);
  return async (job: Job): Promise<unknown> => {
    const envelope = job.data as QueueJobEnvelope<TenantScopedPayload>;
    const tenantJob = toTenantJob(envelope);
    const client = await options.getClient();
    return withTenantContext(client, { workspaceId: tenantJob.data.workspaceId, actorId: SYSTEM_ACTOR_ID }, async (tx) => {
      verify(tenantJob);
      return options.process(tx, job);
    });
  };
};

/** Exported for the breaker-matrix test: runs the worker-factory-level assertion against the misordered processor. */
export async function assertIso11WorkerFactoryProcessorAgainstBrokenOrdering(): Promise<void> {
  await assertIso11WorkerFactoryProcessorRejectsBeforeContext(createJobProcessorVerifyAfterContext);
}

export const iso11Breaker: Breaker = {
  id: "ISO-11",
  description: "swaps in a verifier-after-context ordering (verification-after-context regression)",
  apply: async () => {
    // No database mutation applies here — the breaker demonstrates the
    // regression by running the real assertion against a deliberately
    // misordered withTenantJob (context set up before verify(), the exact
    // defect class ISO-11 exists to catch), since this assertion is entirely
    // application-layer.
  },
  revert: NOOP_REVERT,
};

/**
 * Deliberately broken ordering: opens the transaction and sets context
 * FIRST, then calls `verify` from inside the context-carrying callback —
 * i.e. exactly "verification ordered after context", the regression class
 * ISO-11 exists to catch.
 */
const withTenantJobVerifyAfterContext: WithTenantJobFn = async (client, job, verify, fn) => {
  return withTenantContext(client, { workspaceId: job.data.workspaceId, actorId: SYSTEM_ACTOR_ID }, async (tx) => {
    verify(job);
    return fn(tx);
  });
};

/**
 * Exported for the breaker-matrix test: runs BOTH the with-tenant-job.ts
 * PRIMITIVE-level assertion against the misordered `withTenantJob`, and the
 * worker-factory.ts PRODUCTION-PATH assertion against the misordered
 * `createJobProcessor` — either regression alone must turn this red.
 */
export async function assertIso11AgainstBrokenOrdering(): Promise<void> {
  await assertIso11WithTenantJobLevel(withTenantJobVerifyAfterContext);
  await assertIso11WorkerFactoryProcessorAgainstBrokenOrdering();
}
