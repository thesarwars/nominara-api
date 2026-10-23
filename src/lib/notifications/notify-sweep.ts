// STORY-068 RED stub — replaced by the implementation.
import type { ClientBase } from "pg";
import type { EnqueueNotifyDispatch } from "./routing.js";
export interface DigestTarget { readonly workspaceId: string; readonly userId: string; readonly cadence: "daily" | "weekly"; readonly periodStart: string; readonly periodEnd: string }
export async function findDigestTargets(_client: ClientBase, _now: Date): Promise<DigestTarget[]> { return []; }
export async function runNotifySweep(_client: ClientBase, _enqueue: EnqueueNotifyDispatch, _now: Date): Promise<void> {}
