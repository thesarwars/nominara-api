import { isIP } from "node:net";
import { Logger } from "@nestjs/common";
import type { ClientBase } from "pg";
import { taskVerificationSubmittedPayloadSchema, type TaskVerificationFailedPayload } from "../../../contracts/tasks/index.js";
import type { GuardedResponse } from "../net/guarded-fetch.js";
import { ALLOWED_PORTS, ALLOWED_SCHEMES, isGloballyReachable, type UnsafeTargetReason } from "../net/address-rules.js";
import { withProjectQueueLock } from "../queue/locks.js";
import { refreshProjectSourceIndex } from "../rollup/refresh-project-source-index.js";
import { refreshProjectTaskCounts } from "../rollup/refresh-project-task-counts.js";
import { incrementCounter } from "../telemetry/metrics.js";
import { sourceSeededSourceId, seededTargetUrl, verifyUrlPresence, type BrandForMatching, type PresenceFetcher } from "./verify-presence.js";

// STORY-055 AC5-AC8 + AC11, owner decision 30 (plans-7day/decisions-2026-10-28.md) - the customer's contribution is verified, not
// self-reported. Completing a SEEDING task takes a URL and sends the task to `in_review` (TasksService.completeTask); the
// `source.verify_presence` job then runs these three phases, and the task either becomes `done` or STAYS `in_review` with a
// stated reason (the story: "an unverifiable URL leaves the task in a review state with the reason" - not back to in_progress).
//
// Three rules carry the whole story, the same three as verify-presence.ts:
//   1. THE FETCH IS THE JOB'S (KAD-06) AND GOES THROUGH THE GUARDED FETCHER. `fetch` is injected: the caller passes `guardedFetch`,
//      a test a fake. The request path runs only the PURE host check below.
//   2. NO TRANSACTION IS HELD ACROSS THE FETCH (ADR-0003): `prepare` reads in one short transaction, `fetchSubmission` has no
//      client, `commit` writes in a second short one.
//   3. AN OUTAGE IS NOT AN ACCUSATION, AND A CLAIM IS NOT A FACT: a page that does not name the brand, or is not reachable, is
//      reported with its own reason and closes nothing; only a fetched page that names the brand on the task's own domain does.
//
// Where the URL and the reason live: `task_events` (migration 0155). `verification_submitted` carries `{ url }` and is the
// submission's id; `verification_failed` carries `{ submission_id, reason }`; a success is the `completed` event carrying
// `{ submission_id }`. A submission is ANSWERED once either exists for its id, which is what makes a redelivery a no-op.

const logger = new Logger("verify-submission");

/** The rollup's per-project lock, taken FIRST by every presence write (see verify-presence.ts `PRESENCE_WRITE_LOCK`). */
const PRESENCE_WRITE_LOCK = "rollup.metric_daily";

/** A seeding task: one with a playbook or a source class (a source domain). Only these are completed with a URL. */
export function isSeedingTask(task: { readonly playbook_slug: string | null; readonly source_domain_id: string | null }): boolean {
  return task.playbook_slug !== null || task.source_domain_id !== null;
}

export type SubmittedUrlCheck = { readonly ok: true; readonly url: string } | { readonly ok: false; readonly reason: UnsafeTargetReason };

/** Host names that are internal by their label alone (RFC 6761 `localhost`, mDNS `.local`, the conventional `.internal`, RFC 8375 `.home.arpa`). */
const INTERNAL_SUFFIXES: readonly string[] = [".localhost", ".local", ".internal", ".home.arpa"];

/**
 * STORY-055 scenario 8 - the PURE host check at submit: no DNS, no socket, so it is safe in the request handler (KAD-06). It
 * reuses the guarded fetcher's own rules (allowed schemes and ports, `isGloballyReachable` for an address literal) and its own
 * reasons, so `422 unsafe_target` reads the same on every surface. A public-looking NAME that resolves to a private address is
 * the one thing it cannot see; the guarded fetch in the job refuses that again (`unsafe_target` in the review reason).
 * `new URL` canonicalises the odd literal forms (`127.1`, `0x7f.0.0.1`, `2130706433`) to dotted quads before the check.
 */
export function checkSubmittedUrl(raw: string): SubmittedUrlCheck {
  const trimmed = raw.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: "scheme_not_allowed" };
  }
  if (!ALLOWED_SCHEMES.includes(url.protocol)) return { ok: false, reason: "scheme_not_allowed" };
  if (url.port !== "" && !ALLOWED_PORTS.includes(Number(url.port))) return { ok: false, reason: "port_not_allowed" };

  const host = url.hostname.toLowerCase().replace(/\.$/u, "");
  if (host === "") return { ok: false, reason: "hostname_missing" };
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (isIP(bare) !== 0) return isGloballyReachable(bare) ? { ok: true, url: trimmed } : { ok: false, reason: "address_not_global" };

  const internal = host === "localhost" || !host.includes(".") || INTERNAL_SUFFIXES.some((suffix) => host.endsWith(suffix));
  return internal ? { ok: false, reason: "address_not_global" } : { ok: true, url: trimmed };
}

/** What the job read: everything `fetchSubmission` and `commitSubmissionVerification` need, and nothing else. */
export interface SubmissionPlan {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly submissionId: string;
  readonly url: string;
  /** The submitter: the `completed_by` of the task and the `created_by` of its milestone. */
  readonly submittedBy: string | null;
  readonly title: string;
  readonly sourceDomainId: string | null;
  readonly domain: string | null;
  readonly today: string;
  readonly brand: BrandForMatching;
}

export type SubmissionOutcome =
  | { readonly status: "verified" }
  | { readonly status: "unverified"; readonly reason: TaskVerificationFailedPayload["reason"] };

/**
 * Phase 1 (one short tenant transaction). Null - nothing to fetch - when the task is gone or not visible (another tenant's), is no
 * longer `in_review`, the submission is not its LATEST (a resubmission superseded it), or the submission was already answered (a
 * redelivery). RLS bounds every read to the context's workspace.
 */
export async function prepareSubmissionVerification(tx: ClientBase, projectId: string, taskId: string, submissionId: string): Promise<SubmissionPlan | null> {
  const found = await tx.query<{
    workspace_id: string;
    title: string;
    source_domain_id: string | null;
    domain: string | null;
    name: string;
    brand_aliases: string[];
    negative_aliases: string[];
    today: string;
    payload: unknown;
    actor_id: string | null;
    answered: boolean;
    latest: boolean;
  }>(
    `SELECT p.workspace_id::text AS workspace_id, t.title, t.source_domain_id::text AS source_domain_id, sd.domain,
            p.name, p.brand_aliases, p.negative_aliases,
            to_char((now() AT TIME ZONE w.timezone)::date, 'YYYY-MM-DD') AS today,
            s.payload, s.actor_id::text AS actor_id,
            EXISTS (SELECT 1 FROM task_events a
                     WHERE a.task_id = t.id AND a.payload->>'submission_id' = s.id::text
                       AND a.event IN ('verification_failed', 'completed')) AS answered,
            NOT EXISTS (SELECT 1 FROM task_events n
                         WHERE n.task_id = t.id AND n.event = 'verification_submitted'
                           AND (n.occurred_at, n.id) > (s.occurred_at, s.id)) AS latest
       FROM tasks t
       JOIN projects p   ON p.id = t.project_id AND p.deleted_at IS NULL
       JOIN workspaces w ON w.id = p.workspace_id
       JOIN task_events s ON s.task_id = t.id AND s.id = $3 AND s.event = 'verification_submitted'
       LEFT JOIN source_domains sd ON sd.id = t.source_domain_id
      WHERE t.id = $2 AND t.project_id = $1 AND t.status = 'in_review' AND t.deleted_at IS NULL`,
    [projectId, taskId, submissionId],
  );
  const row = found.rows[0];
  if (row === undefined || row.answered || !row.latest) return null;
  const payload = taskVerificationSubmittedPayloadSchema.safeParse(row.payload);
  if (!payload.success) return null; // a malformed submission is not fetched
  return {
    workspaceId: row.workspace_id,
    projectId,
    taskId,
    submissionId,
    url: payload.data.url,
    submittedBy: row.actor_id,
    title: row.title,
    sourceDomainId: row.source_domain_id,
    domain: row.domain,
    today: row.today,
    brand: { name: row.name, aliases: row.brand_aliases, negativeAliases: row.negative_aliases },
  };
}

/**
 * Phase 2 (NO transaction, no client): fetch the submitted URL through the injected guarded fetcher and say why it does not close
 * the gap, if it does not. The URL (and the page it ended on after redirects) must be on the task's own domain: a mention on
 * another site is not a contribution to THIS platform. Never throws - every failure is a reason the customer can act on.
 */
export async function fetchSubmission(plan: SubmissionPlan, fetch: PresenceFetcher): Promise<SubmissionOutcome> {
  if (plan.domain !== null && seededTargetUrl(plan.url, plan.domain) === null) return { status: "unverified", reason: "wrong_domain" };

  const seen: { response?: GuardedResponse } = {};
  const outcome = await verifyUrlPresence(plan.url, plan.brand, async (url) => {
    seen.response = await fetch(url);
    return seen.response;
  });
  if (outcome.status === "failed") {
    const reason = outcome.reason === "refused" ? "unsafe_target" : outcome.reason === "not_text" ? "not_a_page" : outcome.reason === "no_aliases" ? "no_brand_names" : "unreachable";
    return { status: "unverified", reason };
  }
  if (outcome.status === "absent") return { status: "unverified", reason: "no_mention" };
  if (plan.domain !== null && seen.response !== undefined && seededTargetUrl(seen.response.finalUrl, plan.domain) === null) return { status: "unverified", reason: "wrong_domain" };
  return { status: "verified" };
}

/**
 * Phase 3 (a second short tenant transaction). Returns true when it changed the task. Under the rollup's lock and the task's row
 * lock it re-checks that the task is STILL `in_review` on THIS submission and unanswered (a PATCH out of review, a resubmission or a
 * racing delivery makes it a no-op), then:
 *   - verified: `done`, `completed_at` now, the `task_completed` milestone, the `completed` event, the domain's presence flag
 *     true, the `source_seeded` milestone (AC7) and the index recompute that closes the gap (AC8), then the open counts;
 *   - unverified: a `verification_failed` event with the reason. The task stays `in_review`, and nothing else changes.
 */
export async function commitSubmissionVerification(tx: ClientBase, plan: SubmissionPlan, outcome: SubmissionOutcome, now: Date): Promise<boolean> {
  incrementCounter("nominara_tasks_verification_total", { outcome: outcome.status === "verified" ? "verified" : outcome.reason });
  // The rollup's lock FIRST, before the task row lock: the presence written below must not be lost to a rollup's index rebuild.
  return withProjectQueueLock(tx, PRESENCE_WRITE_LOCK, plan.projectId, () => commitLocked(tx, plan, outcome, now));
}

async function commitLocked(tx: ClientBase, plan: SubmissionPlan, outcome: SubmissionOutcome, now: Date): Promise<boolean> {
  const current = await tx.query(
    `SELECT t.id FROM tasks t
      WHERE t.id = $1 AND t.project_id = $2 AND t.status = 'in_review' AND t.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM task_events n WHERE n.task_id = t.id AND n.event = 'verification_submitted' AND n.id <> $3::uuid
                          AND (n.occurred_at, n.id) > (SELECT s.occurred_at, s.id FROM task_events s WHERE s.id = $3))
        AND NOT EXISTS (SELECT 1 FROM task_events a WHERE a.task_id = t.id AND a.payload->>'submission_id' = $3::text
                          AND a.event IN ('verification_failed', 'completed'))
      FOR NO KEY UPDATE OF t`,
    [plan.taskId, plan.projectId, plan.submissionId],
  );
  if (current.rows.length === 0) {
    logger.log({ event: "task_verification_stale", workspaceId: plan.workspaceId, projectId: plan.projectId, taskId: plan.taskId });
    return false;
  }

  // THE TIMELINE IS STAMPED BY THE DATABASE CLOCK, like completeTask's: the submission event was, and an app-server clock that
  // differs by a second would put the answer before the question. `now` (the job's clock) is only the index's `verified_at`.
  if (outcome.status === "unverified") {
    await tx.query(
      `INSERT INTO task_events (workspace_id, task_id, actor_type, event, from_value, to_value, payload, occurred_at)
       VALUES (app.current_workspace(), $1, 'system', 'verification_failed', 'in_review', 'in_review', $2::jsonb, clock_timestamp())`,
      [plan.taskId, JSON.stringify({ submission_id: plan.submissionId, reason: outcome.reason } satisfies TaskVerificationFailedPayload)],
    );
    incrementCounter("nominara_tasks_events_written_total", { event: "verification_failed" });
    // IDs and the reason code only - never the URL, the brand or page text.
    logger.log({ event: "task_verification_unverified", workspaceId: plan.workspaceId, projectId: plan.projectId, taskId: plan.taskId, reason: outcome.reason });
    return true;
  }

  const completed = await tx.query<{ id: string; occurred_at: Date }>(
    `INSERT INTO milestones (workspace_id, project_id, occurred_at, kind, title, severity, source_type, source_id, created_by)
     VALUES (app.current_workspace(), $1, clock_timestamp(), 'task_completed', $2, 'positive', 'task', $3, $4)
     RETURNING id, occurred_at`,
    [plan.projectId, plan.title, plan.taskId, plan.submittedBy],
  );
  const completedAt = completed.rows[0]!.occurred_at; // the completion instant: the task's, both milestones', and STORY-067's window anchor
  await tx.query(`UPDATE tasks SET status = 'done', completed_at = $2, completed_by = $3, milestone_id = $4 WHERE id = $1`, [
    plan.taskId,
    completedAt,
    plan.submittedBy,
    completed.rows[0]!.id,
  ]);
  await tx.query(
    `INSERT INTO task_events (workspace_id, task_id, actor_type, event, from_value, to_value, payload, occurred_at)
     VALUES (app.current_workspace(), $1, 'system', 'completed', 'in_review', 'done', $2::jsonb, clock_timestamp())`,
    [plan.taskId, JSON.stringify({ submission_id: plan.submissionId })],
  );

  if (plan.sourceDomainId !== null) {
    await tx.query(`UPDATE project_source_index SET brand_present_on_domain = true, verified_at = $3 WHERE project_id = $1 AND source_domain_id = $2`, [
      plan.projectId,
      plan.sourceDomainId,
      now,
    ]);
  }
  // `source_seeded`, once per task for ever (ux_milestones_source). Titled by the DOMAIN, never the task: a task born of a
  // displacement names a competitor in its title, and the portal's competitor exclusion recognises that only on a `task` pin.
  const domainLabel = plan.domain ?? new URL(plan.url).hostname;
  await tx.query(
    `INSERT INTO milestones (workspace_id, project_id, occurred_at, kind, title, severity, source_type, source_id, visible_in_portal)
     VALUES (app.current_workspace(), $1, $2, 'source_seeded', $3, 'positive', 'system', $4, true)
     ON CONFLICT (source_type, source_id) WHERE source_id IS NOT NULL DO NOTHING`,
    [plan.projectId, completedAt, `Source seeded: ${domainLabel}`, sourceSeededSourceId(plan.projectId, plan.taskId)],
  );
  await refreshProjectSourceIndex(tx, plan.projectId, plan.today);
  await refreshProjectTaskCounts(tx, plan.projectId);

  incrementCounter("nominara_tasks_events_written_total", { event: "completed" });
  incrementCounter("nominara_tasks_completed_total", {});
  logger.log({ event: "task_verification_verified", workspaceId: plan.workspaceId, projectId: plan.projectId, taskId: plan.taskId });
  return true;
}
