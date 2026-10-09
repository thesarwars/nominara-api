import type { ClientBase } from "pg";
import type { Job } from "bullmq";
import { describe, expect, it } from "vitest";
import { createJobProcessor } from "../../../src/lib/queue/worker-factory.js";
import { QUEUE_TOPOLOGY } from "../../../src/lib/queue/topology.js";
import { signQueueJobPayload } from "../../../src/lib/queue/envelope.js";
import { TEST_SIGNING_KEYS, fakeClient } from "../../support/queue-test-harness.js";

// STORY-124 — the defect that could not exist before this story.
//
// createJobProcessor acquires a client and nothing ever gave it back,
// because nothing had ever acquired one: every queue's getClient threw.
// The moment a handler runs on a pooled client, a job that does not release
// leaks a connection — and a FAILING job is the one most likely to be
// retried, so the leak is per attempt, not per job.

const TENANT_ENTRY = QUEUE_TOPOLOGY.find((entry) => entry.tenantScoped)!;
const GLOBAL_ENTRY = QUEUE_TOPOLOGY.find((entry) => !entry.tenantScoped)!;

function lease() {
  const released: ClientBase[] = [];
  const client = fakeClient();
  return {
    client,
    released,
    getClient: () => client,
    releaseClient: (c: ClientBase) => {
      released.push(c);
    },
  };
}

function signedJob(): Job {
  const envelope = signQueueJobPayload(
    { workspaceId: "018bcfe5-0000-7000-8000-000000000001", kid: TEST_SIGNING_KEYS.current.kid },
    TEST_SIGNING_KEYS.current.key,
  );
  return { data: envelope } as unknown as Job;
}

describe("STORY-124 · the client is released on every exit path", () => {
  it("scenario 4/5 — released after a handler that succeeds", async () => {
    const l = lease();
    const processor = createJobProcessor(TENANT_ENTRY, {
      keys: TEST_SIGNING_KEYS,
      getClient: l.getClient,
      releaseClient: l.releaseClient,
      process: async () => "ok",
    });

    await processor(signedJob());
    expect(l.released).toEqual([l.client]);
  });

  it("scenario 5 — released after a handler that THROWS", async () => {
    const l = lease();
    const processor = createJobProcessor(TENANT_ENTRY, {
      keys: TEST_SIGNING_KEYS,
      getClient: l.getClient,
      releaseClient: l.releaseClient,
      process: async () => {
        throw new Error("handler blew up");
      },
    });

    await expect(processor(signedJob())).rejects.toThrow("handler blew up");
    expect(l.released, "a failing job is the one most likely to be retried").toEqual([l.client]);
  });

  it("released exactly once, never twice", async () => {
    const l = lease();
    const processor = createJobProcessor(TENANT_ENTRY, {
      keys: TEST_SIGNING_KEYS,
      getClient: l.getClient,
      releaseClient: l.releaseClient,
      process: async () => "ok",
    });

    await processor(signedJob());
    expect(l.released).toHaveLength(1);
  });

  it("a non-tenant-scoped queue releases too — it takes the same client, without the context", async () => {
    const l = lease();
    const processor = createJobProcessor(GLOBAL_ENTRY, {
      keys: TEST_SIGNING_KEYS,
      getClient: l.getClient,
      releaseClient: l.releaseClient,
      process: async () => "ok",
    });

    await processor({ data: {} } as unknown as Job);
    expect(l.released).toEqual([l.client]);
  });

  it("scenario 6 — a rejected signature releases NOTHING, because nothing was acquired", async () => {
    // ISO-11's ordering, from the other side. There is no client to give
    // back, and reaching for one to simplify the try/finally shape is the
    // one change this story must not make.
    const l = lease();
    let acquired = 0;
    const processor = createJobProcessor(TENANT_ENTRY, {
      keys: TEST_SIGNING_KEYS,
      getClient: () => {
        acquired += 1;
        return l.client;
      },
      releaseClient: l.releaseClient,
      process: async () => "should never run",
    });

    // A valid signature, but for a DIFFERENT workspaceId than the payload
    // now carries — the poisoned-entry shape NFR-SEC-04 is about.
    const signed = signQueueJobPayload(
      { workspaceId: "018bcfe5-0000-7000-8000-000000000002", kid: TEST_SIGNING_KEYS.current.kid },
      TEST_SIGNING_KEYS.current.key,
    );
    const tampered = {
      payload: { ...signed.payload, workspaceId: "018bcfe5-0000-7000-8000-000000000099" },
      signature: signed.signature,
    };

    await expect(processor({ data: tampered } as unknown as Job)).rejects.toThrow();
    expect(acquired).toBe(0);
    expect(l.released).toEqual([]);
  });

  it("omitting releaseClient is legal and does nothing — a fake client has nothing to return", async () => {
    // Ten existing test files pass a bare fake through getClient. They must
    // keep working unchanged.
    const processor = createJobProcessor(TENANT_ENTRY, {
      keys: TEST_SIGNING_KEYS,
      getClient: () => fakeClient(),
      process: async () => "ok",
    });
    await expect(processor(signedJob())).resolves.toBe("ok");
  });
});

describe("checkpoint-6 · a lost connection is destroyed, not returned", () => {
  it("D-1 AC-worker-release-err . the failure that ended the job is handed to releaseClient, so the worker can release(err)", async () => {
    const failure = Object.assign(new Error("Connection terminated unexpectedly"), { code: "08P01" });
    const seen: unknown[] = [];
    const client = fakeClient();
    const processor = createJobProcessor(TENANT_ENTRY, {
      keys: TEST_SIGNING_KEYS,
      getClient: () => client,
      releaseClient: (_c: ClientBase, ...rest: unknown[]) => void seen.push(...rest),
      process: async () => {
        throw failure;
      },
    });

    await expect(processor(signedJob())).rejects.toBe(failure);
    expect(seen).toEqual([failure]);
  });
});
