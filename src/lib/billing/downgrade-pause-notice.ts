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

/** The pause-list email, or null when nothing was paused. */
export function downgradePausedEmail(to: string, planName: string, paused: DowngradePauseOutcome["paused"]): EmailMessage | null {
  const { projects, prompts } = paused;
  if (projects.length === 0 && prompts.length === 0) return null;
  const lines: string[] = [
    `Your workspace moved to the ${planName} plan, which allows fewer projects or prompts than you had. ` +
      "Nothing has been deleted: the most recently created items above the new limits are paused, and all their data is kept.",
    "",
  ];
  if (projects.length > 0) {
    lines.push(`${plural(projects.length, "project", "projects")} paused:`);
    for (const project of projects) lines.push(`  - ${project.name}`);
    lines.push("");
  }
  if (prompts.length > 0) {
    lines.push(`${plural(prompts.length, "prompt", "prompts")} paused:`);
    for (const prompt of prompts.slice(0, MAX_NAMED_PROMPTS)) lines.push(`  - ${prompt.text}`);
    if (prompts.length > MAX_NAMED_PROMPTS) lines.push(`  - and ${String(prompts.length - MAX_NAMED_PROMPTS)} more`);
    lines.push("");
  }
  lines.push(
    "Paused items are not tracked, and they resume automatically if you upgrade again. " +
      "To track a different prompt instead, archive one you no longer need and resume the one you want in Nominara.",
  );
  return { to, subject: DOWNGRADE_PAUSED_SUBJECT, textBody: lines.join("\n") };
}

/** The resume email, or null when nothing resumed. */
export function downgradeResumedEmail(to: string, planName: string, resumed: DowngradePauseOutcome["resumed"]): EmailMessage | null {
  if (resumed.projects.length === 0 && resumed.prompts === 0) return null;
  const lines: string[] = [`Your workspace moved to the ${planName} plan. Items paused by an earlier plan change have resumed.`, ""];
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
