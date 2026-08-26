import { Injectable } from "@nestjs/common";
import type { Job, Queue } from "bullmq";
import type { Redis } from "ioredis";
import { dlqEntrySchema, dlqQueueName } from "../../lib/queue/dead-letter.js";
import { signQueueJobPayload, type QueueJobEnvelope, type TenantScopedPayload } from "../../lib/queue/envelope.js";
import { enqueueJob } from "../../lib/queue/queue-factory.js";
import { withReplaySuffix } from "../../lib/queue/idempotency.js";
import type { RotatingSigningKeys } from "../../lib/queue/signing.js";
import type { QueueTopologyEntry } from "../../lib/queue/topology.js";

// STORY-030 AC7 — "Replay from the administrative surface adds a new
// idempotency suffix, so a replayed job cannot collide with the original's
// key." D9: AdminController's HTTP surface (IP allow-list + step-up guard)
// is a separate future story — this is the service-level mechanism only.
//
// A DLQ entry is replayed AT MOST ONCE: it is left in place (never removed —
// it stays the audit record of the original failure) and stamped with
// `replayedAt`, so a second replay attempt on the same entry is rejected
// loudly rather than silently producing a second effect.
//
// Code-review fix (blocking) — a DLQ entry whose ORIGINAL failure was a
// `JobSignatureError` (worker-factory.ts's createJobProcessor rejects a
// tampered/poisoned envelope BEFORE any context call, per ISO-11) must never
// be replayed: `reSign()` would mint a BRAND NEW valid signature over an
// attacker-controlled payload (workspaceId included), laundering exactly the
// poisoned entry ISO-11 exists to stop into one that verifies clean on
// re-enqueue. Checked before any re-signing or enqueueing.
//
// Code-review fix (should-fix) — the read-check-enqueue-write sequence below
// is not otherwise atomic (`withReplaySuffix` mints a fresh UUID per call, so
// nothing stops two concurrent replays of the same jobId both passing the
// `replayedAt` check). Guarded by a short-lived Valkey mutual-exclusion lock
// (`SET ... NX PX`) keyed on jobId — a caller that cannot acquire it is
// refused immediately rather than racing the one that did.

const REPLAY_LOCK_TTL_MS = 5_000;

export class DlqReplayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DlqReplayError";
  }
}

export interface ReplayDeadLetterJobOptions {
  readonly dlqQueue: Queue;
  readonly targetQueue: Queue;
  readonly entry: QueueTopologyEntry;
  readonly jobId: string;
  /** Signs the replayed payload under `keys.current` — a since-rotated kid on the original entry is upgraded, never carried forward. */
  readonly keys: RotatingSigningKeys;
  /** The queue instance's Valkey connection — used ONLY to hold the short-lived per-jobId replay lock, never as a second signing/queue path. */
  readonly connection: Redis;
}

@Injectable()
export class AdminService {
  async replayDeadLetterJob(options: ReplayDeadLetterJobOptions): Promise<Job> {
    const { dlqQueue, targetQueue, entry, jobId, keys, connection } = options;

    // Scoped by DLQ queue name, not jobId alone — BullMQ's per-queue
    // auto-incrementing job id counter means two DIFFERENT DLQ queues can
    // easily share the same numeric jobId, and this lock must never let one
    // queue's replay block (or worse, feel guarded by) another's.
    const lockKey = `dlq-replay-lock:${dlqQueueName(entry.name)}:${jobId}`;
    const acquired = await connection.set(lockKey, "1", "PX", REPLAY_LOCK_TTL_MS, "NX");
    if (acquired !== "OK") {
      throw new DlqReplayError(
        `a replay for dead-letter entry "${jobId}" on "${dlqQueueName(entry.name)}" is already in progress`,
      );
    }

    try {
      const dlqJob = await dlqQueue.getJob(jobId);
      if (!dlqJob) {
        throw new DlqReplayError(`no dead-letter entry "${jobId}" found on "${dlqQueueName(entry.name)}"`);
      }

      const dlqEntry = dlqEntrySchema.parse(dlqJob.data);

      if (dlqEntry.replayedAt) {
        throw new DlqReplayError(
          `dead-letter entry "${jobId}" on "${dlqQueueName(entry.name)}" was already replayed at ${dlqEntry.replayedAt}`,
        );
      }
      if (dlqEntry.error.name === "JobSignatureError") {
        throw new DlqReplayError(
          `dead-letter entry "${jobId}" on "${dlqQueueName(entry.name)}" failed signature verification and must not be replayed — its payload cannot be trusted`,
        );
      }
      if (!dlqEntry.idempotencyKey) {
        throw new DlqReplayError(
          `dead-letter entry "${jobId}" on "${dlqQueueName(entry.name)}" has no recorded idempotency key to replay from`,
        );
      }

      const replayPayload = entry.tenantScoped ? this.reSign(dlqEntry.payload, keys) : dlqEntry.payload;
      const replayIdempotencyKey = withReplaySuffix(dlqEntry.idempotencyKey);

      const replayedJob = await enqueueJob(targetQueue, entry, replayPayload, { idempotencyKey: replayIdempotencyKey });

      await dlqJob.updateData({ ...dlqEntry, replayedAt: new Date().toISOString() });

      return replayedJob;
    } finally {
      await connection.del(lockKey).catch(() => undefined);
    }
  }

  /** Re-signs a tenant-scoped envelope's inner payload under the CURRENT signing key — never the key it arrived signed under. */
  private reSign(payload: unknown, keys: RotatingSigningKeys): QueueJobEnvelope<TenantScopedPayload> {
    const envelope = payload as QueueJobEnvelope<TenantScopedPayload>;
    const rekeyed: TenantScopedPayload = { ...envelope.payload, kid: keys.current.kid };
    return signQueueJobPayload(rekeyed, keys.current.key);
  }
}
