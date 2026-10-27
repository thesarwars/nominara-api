import type { ClientBase } from "pg";
import { RetentionExceededError } from "../../api/errors/domain-errors.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { resolveRetentionCutoff, resolveWorkspaceRetention, retentionPurgeDeferred } from "../../workers/rollup/retention.js";

// STORY-034 AC10 / STORY-181 AC4 - the raw-capture retention window, as the READ paths see it.
//
// `plans.entitlements -> retention.raw_captures_days` is the window (null or "unlimited" = never purged). Past it the answer is gone
// BY POLICY, and the honest response is `507 retention_exceeded` - never an empty result, which would read as "the engine said
// nothing" - and never a 404, which would read as "that never existed". The same function the retention sweep uses decides the
// boundary, so a read and the sweep cannot disagree about which side a capture is on.

/** The oldest `captured_at` still inside the workspace's raw-capture retention, or null when it is never purged. */
export async function rawRetentionCutoff(client: ClientBase, workspaceId: string, now: Date = new Date()): Promise<Date | null> {
  const retention = await resolveWorkspaceRetention(client, workspaceId);
  // STORY-077 slice B: while the first purge is deferred past a retention-shortening notice, the window hides nothing (the data
  // is still there for the customer to export). A capture the sweep already expired stays hidden by its marker.
  if (retentionPurgeDeferred(retention, now)) return null;
  return resolveRetentionCutoff(retention.rawCapturesDays, now);
}

/**
 * Throws `RetentionExceededError` for a capture older than the window, or one the retention sweep already expired (its key nulled
 * and `payload.raw_expired` set - the sweep marks rather than deletes the row, so the marker is how "expired" is told from "never
 * had an object"). `surface` names the caller in the counter only.
 */
export async function assertWithinRawRetention(
  client: ClientBase,
  workspaceId: string,
  capture: { readonly capturedAt: Date; readonly rawExpired: unknown },
  surface: string,
): Promise<void> {
  const cutoff = await rawRetentionCutoff(client, workspaceId);
  const expired = capture.rawExpired === true || capture.rawExpired === "true";
  if (expired || (cutoff !== null && capture.capturedAt < cutoff)) {
    incrementCounter("nominara_tracking_retention_exceeded_total", { surface });
    throw new RetentionExceededError({ message: "this capture is past the workspace's raw-capture retention" });
  }
}
