import { randomUUID } from "node:crypto";
import type { ClientBase } from "pg";
import { signQueueJobPayload, type QueueJobEnvelope, type TenantScopedPayload } from "../../src/lib/queue/envelope.js";
import type { RotatingSigningKeys } from "../../src/lib/queue/signing.js";
import type { QueueTopologyEntry } from "../../src/lib/queue/topology.js";

// STORY-030 Phase B — shared helpers for test/integration/queue-*.spec.ts.
// A single, deliberately small surface so the five queue integration spec
// files build signed envelopes, fake DB clients, and wait conditions the
// SAME way rather than five slightly-different near-copies.

export const TEST_SIGNING_KEYS: RotatingSigningKeys = {
  current: { kid: "test-kid-k1", key: Buffer.alloc(32, 1) },
};

/** current = K2 (rotated), previous = the SAME K1 as TEST_SIGNING_KEYS.current — the overlap window. */
export const TEST_SIGNING_KEYS_ROTATED: RotatingSigningKeys = {
  current: { kid: "test-kid-k2", key: Buffer.alloc(32, 2) },
  previous: TEST_SIGNING_KEYS.current,
};

/** A kid that matches neither TEST_SIGNING_KEYS' current nor previous — simulates a job signed outside the configured rotation window. */
export const OUTSIDE_WINDOW_SIGNING_KEY = { kid: "test-kid-outside-window", key: Buffer.alloc(32, 9) };

/** A minimal pg.ClientBase stand-in — these tests are about queue mechanics, not RLS, so every query resolves trivially. */
export function fakeClient(): ClientBase {
  return {
    query: async () => ({ rows: [], rowCount: 0, command: "", oid: 0, fields: [] }),
  } as unknown as ClientBase;
}

/** Builds a validly-signed envelope for a tenant-scoped queue's job data. */
export function signedEnvelope(
  keys: RotatingSigningKeys = TEST_SIGNING_KEYS,
  extra: Record<string, unknown> = {},
): QueueJobEnvelope<TenantScopedPayload> {
  const payload: TenantScopedPayload = { workspaceId: randomUUID(), kid: keys.current.kid, ...extra };
  return signQueueJobPayload(payload, keys.current.key);
}

/** `entry`'s job data shape: a signed envelope for a tenant-scoped queue, or a plain payload otherwise (`credit.reconcile`/`maintenance.partition`). */
export function jobDataFor(entry: QueueTopologyEntry, extra: Record<string, unknown> = {}): unknown {
  return entry.tenantScoped ? signedEnvelope(TEST_SIGNING_KEYS, extra) : { ...extra };
}

export interface WaitForOptions {
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  readonly label?: string;
}

/** Polls `predicate` until it returns true or `timeoutMs` elapses — this test suite talks to a real Valkey, so completion is observed, never assumed. */
export async function waitFor(predicate: () => boolean | Promise<boolean>, options: WaitForOptions = {}): Promise<void> {
  const { timeoutMs = 10_000, intervalMs = 25, label = "condition" } = options;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) {
      throw new Error(`waitFor: timed out after ${timeoutMs}ms waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
