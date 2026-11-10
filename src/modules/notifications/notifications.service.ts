import { Injectable } from "@nestjs/common";
import type { ClientBase } from "pg";
import {
  notificationDeepLinkSchema,
  type MarkAllNotificationsReadResponse,
  type MarkNotificationReadResponse,
  type Notification,
  type NotificationListQuery,
  type NotificationListResponse,
  type NotificationPreferences,
  type NotificationSeverity,
  type UpdateNotificationPreferencesRequest,
} from "../../../contracts/notifications/index.js";
import { NotFoundError } from "../../api/errors/domain-errors.js";
import { Page, pageFrom } from "../../api/pagination/page.js";
import { decodeTimestampIdCursor, MICROS_FORMAT } from "../../api/pagination/timestamp-id-cursor.js";
import { effectiveCadence, visibleProjects, visibleToMemberSql } from "../../lib/notifications/audience.js";
import { currentTenantStore } from "../../tenancy/tenant-context.js";

// STORY-068 — the in-app inbox. Every read and write runs in the request's tenant transaction (RLS scopes the workspace);
// what the CALLER may see inside it is lib/notifications/audience.ts's one definition: their own user-addressed rows,
// every workspace-wide row, and only the projects their role may read.
//
// AC8 — READ STATE IS PER USER. `notification_reads` holds one receipt per (notification, reader); `notifications.read_at`
// is never read or written. Marking read is idempotent (ON CONFLICT DO NOTHING keeps the first read time).

export interface Viewer {
  readonly userId: string;
  readonly role: string;
  readonly projectScope: readonly string[] | null;
}

const LIST = "notifications.inbox";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

interface Row {
  id: string;
  project_id: string | null;
  user_id: string | null;
  kind: string;
  severity: NotificationSeverity;
  title: string;
  body: string | null;
  payload: Record<string, unknown> | null;
  created_at: Date;
  created_at_key: string;
  read_at: Date | null;
}

function toNotification(row: Row): Notification {
  const link = notificationDeepLinkSchema.safeParse(row.payload?.deep_link);
  const taskId = row.payload?.task_id;
  return {
    id: row.id,
    project_id: row.project_id,
    kind: row.kind,
    severity: row.severity,
    title: row.title,
    body: row.body,
    audience: row.user_id === null ? "workspace" : "user",
    deep_link: link.success ? link.data : null,
    task_id: typeof taskId === "string" ? taskId : null,
    read: row.read_at !== null,
    read_at: row.read_at === null ? null : row.read_at.toISOString(),
    created_at: row.created_at.toISOString(),
  };
}

@Injectable()
export class NotificationsService {
  private store(): { client: ClientBase; workspaceId: string } {
    const store = currentTenantStore();
    if (store === undefined) throw new Error("NotificationsService needs the request's tenant transaction");
    return { client: store.client, workspaceId: store.context.workspaceId };
  }

  private scope(viewer: Viewer): string[] | null {
    const visible = visibleProjects(viewer.role, viewer.projectScope);
    return visible === null ? null : [...visible];
  }

  async list(viewer: Viewer, query: NotificationListQuery): Promise<Page<Notification, NotificationListResponse>> {
    const { client, workspaceId } = this.store();
    const after = query.cursor === undefined ? undefined : decodeTimestampIdCursor(query.cursor, LIST);
    const rows = await client.query<Row>(
      `SELECT n.id, n.project_id, n.user_id, n.kind, n.severity, n.title, n.body, n.payload, n.created_at,
              to_char(n.created_at AT TIME ZONE 'UTC', ${MICROS_FORMAT}) AS created_at_key, r.read_at
         FROM notifications n
         LEFT JOIN notification_reads r ON r.notification_id = n.id AND r.user_id = $2::uuid
        WHERE n.workspace_id = $1
          AND ${visibleToMemberSql("$2", "$3")}
          AND ($4::boolean = false OR r.read_at IS NULL)
          AND ($5::timestamptz IS NULL OR (n.created_at, n.id) < ($5::timestamptz, $6::uuid))
        ORDER BY n.created_at DESC, n.id DESC
        LIMIT $7`,
      [workspaceId, viewer.userId, this.scope(viewer), query.unread === "true", after?.[0] ?? null, after?.[1] ?? null, query.limit + 1],
    );
    const page = pageFrom(rows.rows, query.limit, LIST, toNotification, (row) => [row.created_at_key, row.id]);
    const unread = await this.unreadCount(client, workspaceId, viewer);
    return new Page<Notification, NotificationListResponse>(page.items, page.pagination, { notifications: [...page.items], unread_count: unread });
  }

  async markRead(viewer: Viewer, notificationId: string): Promise<MarkNotificationReadResponse> {
    const { client, workspaceId } = this.store();
    // Not an id at all is not a notification: a 404, never a cast error.
    if (!UUID.test(notificationId)) throw new NotFoundError({ message: "no such notification" });
    // Only a notification the caller can see: another user's, or another project's, is a 404 (never "forbidden", which
    // would confirm it exists).
    const visible = await client.query<{ id: string }>(
      `SELECT n.id FROM notifications n WHERE n.id = $4::uuid AND n.workspace_id = $1 AND ${visibleToMemberSql("$2", "$3")}`,
      [workspaceId, viewer.userId, this.scope(viewer), notificationId],
    );
    if (visible.rows[0] === undefined) throw new NotFoundError({ message: "no such notification" });
    await client.query(
      `INSERT INTO notification_reads (workspace_id, notification_id, user_id) VALUES ($1, $2, $3)
       ON CONFLICT (notification_id, user_id) DO NOTHING`,
      [workspaceId, notificationId, viewer.userId],
    );
    const readAt = await client.query<{ read_at: Date }>("SELECT read_at FROM notification_reads WHERE notification_id = $1 AND user_id = $2", [notificationId, viewer.userId]);
    return { id: notificationId, read_at: readAt.rows[0]!.read_at.toISOString(), unread_count: await this.unreadCount(client, workspaceId, viewer) };
  }

  async markAllRead(viewer: Viewer): Promise<MarkAllNotificationsReadResponse> {
    const { client, workspaceId } = this.store();
    const marked = await client.query(
      `INSERT INTO notification_reads (workspace_id, notification_id, user_id)
       SELECT n.workspace_id, n.id, $2::uuid FROM notifications n
        WHERE n.workspace_id = $1 AND ${visibleToMemberSql("$2", "$3")}
          AND NOT EXISTS (SELECT 1 FROM notification_reads r WHERE r.notification_id = n.id AND r.user_id = $2::uuid)
       ON CONFLICT (notification_id, user_id) DO NOTHING`,
      [workspaceId, viewer.userId, this.scope(viewer)],
    );
    return { marked: marked.rowCount ?? 0, unread_count: await this.unreadCount(client, workspaceId, viewer) };
  }

  async preferences(viewer: Viewer): Promise<NotificationPreferences> {
    const { client, workspaceId } = this.store();
    const row = await client.query<{ digest_cadence: string | null; sentiment_alerts_enabled: boolean | null }>(
      "SELECT digest_cadence, sentiment_alerts_enabled FROM workspace_members WHERE workspace_id = $1 AND user_id = $2 AND status = 'active'",
      [workspaceId, viewer.userId],
    );
    const stored = row.rows[0]?.digest_cadence ?? null;
    return { digest_cadence: effectiveCadence(viewer.role, stored), is_default: stored === null, sentiment_alerts: row.rows[0]?.sentiment_alerts_enabled !== false };
  }

  /** The caller's OWN membership row, never another member's. A key left out of the body is left as it is; `null` returns it to its default. */
  async updatePreferences(viewer: Viewer, body: UpdateNotificationPreferencesRequest): Promise<NotificationPreferences> {
    const { client, workspaceId } = this.store();
    await client.query(
      `UPDATE workspace_members
          SET digest_cadence = CASE WHEN $3::boolean THEN $4 ELSE digest_cadence END,
              sentiment_alerts_enabled = CASE WHEN $5::boolean THEN $6::boolean ELSE sentiment_alerts_enabled END,
              updated_at = now()
        WHERE workspace_id = $1 AND user_id = $2 AND status = 'active'`,
      [workspaceId, viewer.userId, body.digest_cadence !== undefined, body.digest_cadence ?? null, body.sentiment_alerts !== undefined, body.sentiment_alerts ?? null],
    );
    return this.preferences(viewer);
  }

  private async unreadCount(client: ClientBase, workspaceId: string, viewer: Viewer): Promise<number> {
    const result = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM notifications n
        WHERE n.workspace_id = $1 AND ${visibleToMemberSql("$2", "$3")}
          AND NOT EXISTS (SELECT 1 FROM notification_reads r WHERE r.notification_id = n.id AND r.user_id = $2::uuid)`,
      [workspaceId, viewer.userId, this.scope(viewer)],
    );
    return result.rows[0]?.n ?? 0;
  }
}
