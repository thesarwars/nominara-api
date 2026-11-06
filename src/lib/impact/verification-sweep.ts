import { Logger } from "@nestjs/common";
import type { ClientBase } from "pg";
import { incrementCounter } from "../telemetry/metrics.js";
import { findDueVerifications } from "./verification-schedule.js";
import { settleVerifications } from "./verification-settle.js";

// STORY-067 - the verification half of the hourly capture sweep. Two best-effort steps, neither holding a transaction across the
// queue (ADR-0003):
//
//   1. ENQUEUE what is due. The owner connection reads ids of `pending` rows whose `due_at` has passed and enqueues ONE signed
//      `capture.plan` job per row under the key `verification:{id}`. The handler (not this sweep) re-derives everything and flips the
//      row, so a replayed or duplicate job plans nothing twice. Nothing is claimed or locked here.
//   2. SETTLE what ran (verification-settle.ts): a finished run's row becomes `done`, and the long horizon's impact is written.

const logger = new Logger("task.verification.sweep");

export interface VerificationJob {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly verificationId: string;
  readonly idempotencyKey: string;
}
export type EnqueueVerification = (job: VerificationJob) => Promise<void>;

export interface VerificationSweepResult {
  readonly due: number;
  readonly enqueued: number;
  readonly failed: number;
  readonly settled: number;
}

export const verificationIdempotencyKey = (verificationId: string): string => `verification:${verificationId}`;

export async function runVerificationSweep(client: ClientBase, enqueue: EnqueueVerification | undefined, now: Date): Promise<VerificationSweepResult> {
  let enqueued = 0;
  let failed = 0;
  let due = 0;
  if (enqueue !== undefined) {
    const refs = await findDueVerifications(client, now);
    due = refs.length;
    for (const ref of refs) {
      try {
        await enqueue({ workspaceId: ref.workspaceId, projectId: ref.projectId, verificationId: ref.id, idempotencyKey: verificationIdempotencyKey(ref.id) });
        enqueued += 1;
        incrementCounter("nominara_tasks_verifications_enqueued_total", {});
      } catch (error) {
        failed += 1;
        incrementCounter("nominara_tasks_verification_enqueue_failed_total", {});
        logger.error({ event: "task.verification.enqueue_failed", workspace_id: ref.workspaceId, verification_id: ref.id, error: error instanceof Error ? error.name : "unknown" });
      }
    }
  }
  const settled = await settleVerifications(client, now);
  logger.log({ event: "task.verification.sweep", due, enqueued, failed, settled: settled.settled, waiting: settled.waiting, settle_failed: settled.failed });
  return { due, enqueued, failed, settled: settled.settled };
}
