import type { ClientBase } from "pg";
import type { EmailMessage } from "../../modules/identity/ports/email-sender.js";
import type { DowngradePauseOutcome } from "./downgrade-pause.js";

// STORY-077 slice A — plans-and-entitlements.md §14: the cut-over "pauses — never deletes — the most recently created
// excess projects and prompts, retains all their data under the new retention tier, and emails the list". The story's
// technical note: "Emailing the list means the customer can immediately correct a wrong guess." So the email names
// every paused project and prompt (up to a bound; the count is always exact), says nothing was deleted, and says how to
// get them back. A later upgrade that resumes them says which came back (planner recommendation, partial upgrade).

export const DOWNGRADE_PAUSED_SUBJECT = "Some of your projects and prompts were paused by your plan change";
export const DOWNGRADE_RESUMED_SUBJECT = "Your paused projects and prompts have resumed";

/** The most prompt texts named in one email. The count is exact regardless. */
const MAX_NAMED_PROMPTS = 50;

const plural = (n: number, one: string, many: string): string => `${String(n)} ${n === 1 ? one : many}`;
/**
 * What moved the limits. `planChanged` false: the plan stayed and only the add-ons changed (an add-on removed in the
 * billing portal, review round 3) - the copy must not claim the workspace moved plan.
 */
export interface LimitChange {
  /** The plan now held; null when the plan join missed. */
  readonly planName: string | null;
  readonly planChanged: boolean;
}

/** The opening clause; a missing plan name (the plan join missed) names no plan rather than inventing one. */
const openingOf = (change: LimitChange): string => {
  if (!change.planChanged) return "Your workspace's add-ons changed";
  return change.planName === null ? "Your workspace changed plan" : `Your workspace moved to the ${change.planName} plan`;
};

/** The pause-list email, or null when nothing was paused. */
export function downgradePausedEmail(to: string, change: LimitChange, paused: DowngradePauseOutcome["paused"]): EmailMessage | null {
  const { projects, prompts } = paused;
  if (projects.length === 0 && prompts.length === 0) return null;
  const lines: string[] = [
    `${openingOf(change)}, which allows fewer projects or prompts than you had. ` +
      "Nothing has been deleted: the most recently created items above the new limits are paused, and all their data is kept.",
    "",
  ];
  // A prompt paused WITH its project is covered by the project's line; the prompt list names only prompts paused in a
  // project that is kept (review round 2: listing both double-counts what stopped being tracked). Counted by project ID,
  // never by name: two projects may share a name (review round 3).
  const withProject = new Map<string, number>();
  for (const prompt of prompts) if (prompt.withProject) withProject.set(prompt.projectId, (withProject.get(prompt.projectId) ?? 0) + 1);
  const onTheirOwn = prompts.filter((prompt) => !prompt.withProject);
  if (projects.length > 0) {
    lines.push(`${plural(projects.length, "project", "projects")} paused:`);
    for (const project of projects) {
      const n = withProject.get(project.id) ?? 0;
      lines.push(n > 0 ? `  - ${project.name} (and its ${plural(n, "prompt", "prompts")})` : `  - ${project.name}`);
    }
    lines.push("");
  }
  if (onTheirOwn.length > 0) {
    lines.push(`${plural(onTheirOwn.length, "prompt", "prompts")} paused:`);
    for (const prompt of onTheirOwn.slice(0, MAX_NAMED_PROMPTS)) lines.push(`  - ${prompt.text}`);
    if (onTheirOwn.length > MAX_NAMED_PROMPTS) lines.push(`  - and ${String(onTheirOwn.length - MAX_NAMED_PROMPTS)} more`);
    lines.push("");
  }
  lines.push(
    "Paused items are not tracked, and they resume automatically if you upgrade again. " +
      "To track a different prompt instead, archive one you no longer need and resume the one you want in Nominara.",
  );
  return { to, subject: DOWNGRADE_PAUSED_SUBJECT, textBody: lines.join("\n") };
}

/** The resume email, or null when nothing resumed. */
export function downgradeResumedEmail(to: string, change: LimitChange, resumed: DowngradePauseOutcome["resumed"]): EmailMessage | null {
  if (resumed.projects.length === 0 && resumed.prompts === 0) return null;
  const lines: string[] = [`${openingOf(change)}. Items paused by an earlier plan change have resumed.`, ""];
  if (resumed.projects.length > 0) {
    lines.push(`${plural(resumed.projects.length, "project", "projects")} resumed:`);
    for (const project of resumed.projects) lines.push(`  - ${project.name}`);
    lines.push("");
  }
  if (resumed.prompts > 0) lines.push(`${plural(resumed.prompts, "prompt", "prompts")} resumed.`, "");
  lines.push("Anything still above the plan's limits stays paused, with its data kept.");
  return { to, subject: DOWNGRADE_RESUMED_SUBJECT, textBody: lines.join("\n") };
}

/**
 * The workspace's billing email, else its longest-standing active owner's; null when neither exists. The same reading
 * the auto top-up notice uses (kept separate here so this slice changes nothing next to the wallet).
 */
export async function downgradeNoticeContact(tx: ClientBase, workspaceId: string): Promise<string | null> {
  const result = await tx.query<{ email: string | null }>(
    `SELECT COALESCE(
              w.billing_email::text,
              (SELECT u.email::text FROM workspace_members m JOIN users u ON u.id = m.user_id
                WHERE m.workspace_id = w.id AND m.role = 'owner' AND m.status = 'active' AND u.deleted_at IS NULL
                ORDER BY m.joined_at, m.id LIMIT 1)
            ) AS email
       FROM workspaces w WHERE w.id = $1 AND w.deleted_at IS NULL`,
    [workspaceId],
  );
  return result.rows[0]?.email ?? null;
}
