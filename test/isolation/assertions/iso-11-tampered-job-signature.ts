import { createHmac, randomBytes } from "node:crypto";
import type { ClientBase } from "pg";
import { withTenantJob, hmacSha256JobVerifier, type TenantJob } from "../../../src/tenancy/with-tenant-job.js";
import { withTenantContext } from "../../../src/tenancy/tenant-context.js";
import { SYSTEM_ACTOR_ID } from "../../../src/tenancy/constants.js";
import { JobSignatureError } from "../../../src/tenancy/errors.js";
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
export async function assertIso11TamperedJobRejectedPreContext(run: WithTenantJobFn = withTenantJob): Promise<void> {
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

/** Exported for the breaker-matrix test: runs the REAL assertion against the misordered withTenantJob — expected to throw the assertion's own "query() call(s) occurred BEFORE" message. */
export async function assertIso11AgainstBrokenOrdering(): Promise<void> {
  await assertIso11TamperedJobRejectedPreContext(withTenantJobVerifyAfterContext);
}
