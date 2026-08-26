import type { Job } from "bullmq";
import type { ClientBase } from "pg";
import { describe, expect, it } from "vitest";
import { JobSignatureError } from "../../../src/tenancy/errors.js";
import { signQueueJobPayload, type QueueJobEnvelope, type TenantScopedPayload } from "../../../src/lib/queue/envelope.js";
import type { RotatingSigningKeys } from "../../../src/lib/queue/signing.js";
import { createJobProcessor, type JobProcessorOptions } from "../../../src/lib/queue/worker-factory.js";
import { QUEUE_TOPOLOGY } from "../../../src/lib/queue/topology.js";

// STORY-030 Phase C — malformed-envelope edge cases at createJobProcessor's
// own level (the function every real worker runs), extending signing.spec.ts
// / the iso-11 assertions with the specific poisoned-entry shapes a Valkey
// entry can take on the wire that a well-behaved producer would never emit:
// no signature field at all, `signature: null`, `signature: ""`. Every one
// must be rejected before `getClient()` is ever called — same ordering
// guarantee ISO-11 already proves for a tampered/wrong-key payload.

const TENANT_SCOPED_ENTRY = QUEUE_TOPOLOGY.find((entry) => entry.name === "capture.execute")!;
const GLOBAL_ENTRY = QUEUE_TOPOLOGY.find((entry) => entry.name === "credit.reconcile")!;

const KEYS: RotatingSigningKeys = { current: { kid: "wf-test-kid", key: Buffer.alloc(32, 7) } };

function job(data: unknown): Job {
  return { data } as unknown as Job;
}

function goodEnvelope(): QueueJobEnvelope<TenantScopedPayload> {
  return signQueueJobPayload({ workspaceId: "018bcfe5-0000-7000-8000-00000000000f", kid: KEYS.current.kid }, KEYS.current.key);
}

async function expectRejectedBeforeGetClient(data: unknown): Promise<void> {
  let getClientCalls = 0;
  const options: JobProcessorOptions = {
    keys: KEYS,
    getClient: () => {
      getClientCalls += 1;
      return {} as ClientBase;
    },
    process: async () => "should never run",
  };
  const processor = createJobProcessor(TENANT_SCOPED_ENTRY, options);

  await expect(processor(job(data))).rejects.toThrow(JobSignatureError);
  expect(getClientCalls).toBe(0);
}

describe("STORY-030 · createJobProcessor — malformed envelope shapes are rejected before getClient()", () => {
  it("rejects an envelope with no signature field at all", async () => {
    const envelope = goodEnvelope();
    const { signature: _signature, ...withoutSignature } = envelope;
    await expectRejectedBeforeGetClient(withoutSignature);
  });

  it("rejects an envelope with signature: null", async () => {
    const envelope = goodEnvelope();
    await expectRejectedBeforeGetClient({ payload: envelope.payload, signature: null });
  });

  it("rejects an envelope with signature: \"\"", async () => {
    const envelope = goodEnvelope();
    await expectRejectedBeforeGetClient({ payload: envelope.payload, signature: "" });
  });

  it("rejects an envelope whose payload is missing kid entirely", async () => {
    const envelope = goodEnvelope();
    const { kid: _kid, ...payloadWithoutKid } = envelope.payload;
    // Re-sign over the kid-less payload so this exercises the "missing kid",
    // not "tampered/tampered-signature", failure path.
    const { signJobPayload } = await import("../../../src/lib/queue/signing.js");
    const signature = signJobPayload(payloadWithoutKid, KEYS.current.key);
    await expectRejectedBeforeGetClient({ payload: payloadWithoutKid, signature });
  });

  it("rejects an envelope whose payload has workspaceId: null, signed exactly as-is (not tampered)", async () => {
    const { signJobPayload } = await import("../../../src/lib/queue/signing.js");
    const payload = { workspaceId: null, kid: KEYS.current.kid };
    const signature = signJobPayload(payload, KEYS.current.key);
    await expectRejectedBeforeGetClient({ payload, signature });
  });
});

describe("STORY-030 · createJobProcessor — a GLOBAL (non-tenant-scoped) queue's job takes the unsigned path", () => {
  it("credit.reconcile (tenantScoped: false) runs process() directly with a plain, unsigned payload — no envelope required", async () => {
    expect(GLOBAL_ENTRY.tenantScoped).toBe(false);

    let receivedJob: Job | undefined;
    let getClientCalls = 0;
    const options: JobProcessorOptions = {
      keys: KEYS,
      getClient: () => {
        getClientCalls += 1;
        return {} as ClientBase;
      },
      process: async (_tx, receivedJobArg) => {
        receivedJob = receivedJobArg;
        return "ok";
      },
    };
    const processor = createJobProcessor(GLOBAL_ENTRY, options);

    const plainJob = job({ bucket: "2026-08-25T00" });
    const result = await processor(plainJob);

    expect(result).toBe("ok");
    expect(receivedJob).toBe(plainJob);
    expect(getClientCalls).toBe(1);
  });
});
