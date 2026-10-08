import type { ClientBase } from "pg";

// NEW-A-13 — RED stub. Signatures only; behaviour lands in the fix commit.

export class SchedulerBlindError extends Error {}

export interface SweepJob {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly idempotencyKey: string;
}
export type SweepEnqueue = (job: SweepJob) => Promise<void>;
export interface SchedulerSweepResult {
  readonly status: "complete" | "partial";
  readonly claimed: number;
  readonly enqueued: number;
  readonly failed: number;
}

export function sweepIdempotencyKey(_projectId: string, _nextRunAt: Date): string {
  return "";
}
export function nextSweepAfter(now: Date): Date {
  return now;
}
export async function runSchedulerSweep(
  _client: ClientBase,
  _enqueue: SweepEnqueue,
  _now: Date,
): Promise<SchedulerSweepResult> {
  return { status: "complete", claimed: 0, enqueued: 0, failed: 0 };
}

export interface SweepRuntimeOptions {
  readonly connect: () => Promise<ClientBase & { end(): Promise<void> }>;
  readonly enqueue: SweepEnqueue;
  readonly clock?: () => Date;
}
export class SchedulerSweepRuntime {
  constructor(_options: SweepRuntimeOptions) {}
  async tick(): Promise<SchedulerSweepResult | null> {
    return null;
  }
  start(): void {}
  stop(): void {}
}
