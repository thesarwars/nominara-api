import { createHmac, timingSafeEqual } from "node:crypto";
import type { ClientBase } from "pg";
import { SYSTEM_ACTOR_ID } from "./constants.js";
import { JobSignatureError } from "./errors.js";
import { withTenantContext } from "./tenant-context.js";

// STORY-011 — security-and-tenancy.md §4's worker-side context helper.
// Deliberately does NOT build queue key rotation, Valkey integration, or
// BullMQ types — that is a future queue-epic story's job. The JobVerifier
// function-type seam below is what lets that story swap in the real
// production verifier later without touching this file.

export interface TenantJob<D = unknown> {
  readonly data: D & { readonly workspaceId: string };
  readonly signature: string;
}

/** Throws JobSignatureError when `job`'s signature does not verify. */
export type JobVerifier = (job: TenantJob) => void;

/**
 * Verifies `job`'s signature BEFORE any context is set or any query runs —
 * this is the FIRST executable statement, before BEGIN, before any
 * `client.query` call of any kind (security-and-tenancy.md §4's
 * NFR-SEC-04: "a poisoned Valkey entry cannot redirect a worker into
 * another tenant"). Then delegates to withTenantContext with the actor
 * always set to SYSTEM_ACTOR_ID — worker jobs are never attributed to a
 * caller-supplied actor.
 */
export async function withTenantJob<T>(
  client: ClientBase,
  job: TenantJob,
  verify: JobVerifier,
  fn: (tx: ClientBase) => Promise<T>,
): Promise<T> {
  verify(job);
  return withTenantContext(client, { workspaceId: job.data.workspaceId, actorId: SYSTEM_ACTOR_ID }, fn);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = sortKeysDeep(source[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * A real (if minimal) HMAC-SHA256 verifier: signs the canonical JSON of
 * `job.data` (object keys sorted recursively, so key order in the payload
 * never affects the signature) with `key`, hex-encodes the digest, and
 * compares against `job.signature` using crypto.timingSafeEqual — so a
 * genuinely tampered payload or signature is rejected, not just a stub that
 * always passes. Uses only node:crypto — no new dependency.
 */
export function hmacSha256JobVerifier(key: Buffer): JobVerifier {
  return (job: TenantJob): void => {
    const expected = createHmac("sha256", key).update(canonicalJson(job.data)).digest();

    if (!/^[0-9a-fA-F]+$/.test(job.signature) || job.signature.length !== expected.length * 2) {
      throw new JobSignatureError("job signature is not a valid hex-encoded HMAC-SHA256 digest");
    }

    const provided = Buffer.from(job.signature, "hex");
    if (!timingSafeEqual(provided, expected)) {
      throw new JobSignatureError("job signature verification failed");
    }
  };
}
