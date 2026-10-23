import type { ClientBase } from "pg";
import { notificationDeepLinkSchema, type NotificationSeverity } from "../../../contracts/notifications/index.js";
import { emailableMembers, visibleToMemberSql } from "./audience.js";
import { renderDigestEmail, type DigestItem } from "./render.js";

// STORY-068 AC9 / AC10 — assembling ONE member's digest for ONE period, inside the `notify.dispatch` job's first (short)
// tenant transaction. The send happens afterwards with no transaction open (ADR-0003).
//
//   * COALESCED (AC9): every notification of the period the member may see becomes one line of ONE email.
//   * NOTHING TO SAY IS NOT SENT (AC10): a period with nothing left is recorded as `skipped_empty` and no email exists.
//     "Nothing left" excludes what the member already READ in the app (they have seen it) and what was already EMAILED
//     at once (a critical notification: its `channels` carry `email`), so a digest never repeats an urgent email.
//   * ONCE PER PERIOD (AC11): the outbox row's (workspace, user, `digest:{cadence}:{period}`) key is unique, so a
//     retried or duplicated job finds the row it recorded and never assembles twice.
//   * THE MEMBER'S CHOICE IS RE-READ HERE: a member who switched to `off`, or to another cadence, since the sweep asked
//     gets nothing for this one.

export interface DigestRequest {
  readonly workspaceId: string;
  readonly userId: string;
  readonly cadence: "daily" | "weekly";
  /** ISO instants: the period is [start, end). */
  readonly periodStart: string;
  readonly periodEnd: string;
}

export type DigestPrepared =
  | { readonly outcome: "pending"; readonly emailId: string }
  | { readonly outcome: "skipped_empty" | "already_sent" | "not_subscribed" };

/** The outbox key of one member's digest for one period. The period start is the instant, at full precision. */
export function digestDedupeKey(cadence: string, periodStart: string): string {
  return `digest:${cadence}:${new Date(periodStart).toISOString()}`;
}

export async function prepareDigest(tx: ClientBase, request: DigestRequest, options: { readonly appOrigin?: string } = {}): Promise<DigestPrepared> {
  const dedupeKey = digestDedupeKey(request.cadence, request.periodStart);
  const existing = await tx.query<{ id: string; status: string }>(
    "SELECT id, status FROM notification_emails WHERE workspace_id = $1 AND user_id = $2 AND dedupe_key = $3",
    [request.workspaceId, request.userId, dedupeKey],
  );
  const found = existing.rows[0];
  if (found !== undefined) {
    if (found.status === "pending") return { outcome: "pending", emailId: found.id };
    return { outcome: found.status === "sent" ? "already_sent" : "skipped_empty" };
  }

  const [member] = await emailableMembers(tx, request.workspaceId, request.userId);
  if (member === undefined || member.cadence !== request.cadence) return { outcome: "not_subscribed" };

  const rows = await tx.query<{ title: string; body: string | null; severity: NotificationSeverity; deep_link: unknown }>(
    `SELECT n.title, n.body, n.severity, n.payload->'deep_link' AS deep_link
       FROM notifications n
      WHERE n.workspace_id = $1
        AND ${visibleToMemberSql("$2", "$3")}
        AND n.created_at >= $4::timestamptz AND n.created_at < $5::timestamptz
        AND NOT ('email' = ANY(n.channels))
        AND NOT EXISTS (SELECT 1 FROM notification_reads r WHERE r.notification_id = n.id AND r.user_id = $2::uuid)
      ORDER BY n.created_at, n.id`,
    [request.workspaceId, request.userId, member.visible === null ? null : [...member.visible], request.periodStart, request.periodEnd],
  );
  const items: DigestItem[] = rows.rows.map((row) => {
    const link = notificationDeepLinkSchema.safeParse(row.deep_link);
    return { title: row.title, body: row.body, severity: row.severity, deepLink: link.success ? link.data : null };
  });

  if (items.length === 0) {
    await tx.query(
      `INSERT INTO notification_emails (workspace_id, user_id, kind, dedupe_key, cadence, period_start, period_end, notification_count, status)
       VALUES ($1, $2, 'digest', $3, $4, $5, $6, 0, 'skipped_empty')
       ON CONFLICT (workspace_id, user_id, dedupe_key) DO NOTHING`,
      [request.workspaceId, request.userId, dedupeKey, request.cadence, request.periodStart, request.periodEnd],
    );
    return { outcome: "skipped_empty" };
  }

  const zone = (await tx.query<{ timezone: string }>("SELECT timezone FROM workspaces WHERE id = $1", [request.workspaceId])).rows[0]?.timezone ?? "UTC";
  const rendered = renderDigestEmail({ cadence: request.cadence, periodLabel: periodLabel(request, zone), items, appOrigin: options.appOrigin });
  const inserted = await tx.query<{ id: string }>(
    `INSERT INTO notification_emails (workspace_id, user_id, kind, dedupe_key, cadence, period_start, period_end, notification_count, status, subject, text_body)
     VALUES ($1, $2, 'digest', $3, $4, $5, $6, $7, 'pending', $8, $9)
     ON CONFLICT (workspace_id, user_id, dedupe_key) DO NOTHING
     RETURNING id`,
    [request.workspaceId, request.userId, dedupeKey, request.cadence, request.periodStart, request.periodEnd, items.length, rendered.subject, rendered.textBody],
  );
  const emailId = inserted.rows[0]?.id;
  // A concurrent job recorded it first: that job sends it.
  return emailId === undefined ? { outcome: "already_sent" } : { outcome: "pending", emailId };
}

/** "12 Oct 2026" or "12 Oct to 18 Oct 2026", in the WORKSPACE's zone (the period is its local midnight to midnight). */
function periodLabel(request: DigestRequest, timezone: string): string {
  let zone = timezone;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone });
  } catch {
    zone = "UTC";
  }
  const day = new Intl.DateTimeFormat("en-GB", { timeZone: zone, day: "numeric", month: "short" });
  const year = new Intl.DateTimeFormat("en-GB", { timeZone: zone, year: "numeric" });
  const start = new Date(request.periodStart);
  const lastInstant = new Date(new Date(request.periodEnd).getTime() - 1);
  return request.cadence === "daily" ? `${day.format(start)} ${year.format(start)}` : `${day.format(start)} to ${day.format(lastInstant)} ${year.format(lastInstant)}`;
}
