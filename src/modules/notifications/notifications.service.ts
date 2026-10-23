// STORY-068 RED stub — replaced by the implementation.
import type { MarkAllNotificationsReadResponse, MarkNotificationReadResponse, Notification, NotificationListQuery, NotificationListResponse } from "../../../contracts/notifications/index.js";
import { Page } from "../../api/pagination/page.js";
export interface Viewer { readonly userId: string; readonly role: string; readonly projectScope: readonly string[] | null }
export class NotificationsService {
  async list(_viewer: Viewer, query: NotificationListQuery): Promise<Page<Notification, NotificationListResponse>> {
    return new Page<Notification, NotificationListResponse>([], { cursor_next: null, has_more: false, limit: query.limit }, { notifications: [], unread_count: 0 });
  }
  async markRead(_viewer: Viewer, id: string): Promise<MarkNotificationReadResponse> { return { id, read_at: "", unread_count: -1 }; }
  async markAllRead(_viewer: Viewer): Promise<MarkAllNotificationsReadResponse> { return { marked: -1, unread_count: -1 }; }
}
