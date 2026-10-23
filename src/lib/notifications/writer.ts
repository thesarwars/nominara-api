// STORY-068 RED stub — replaced by the implementation.
import type { ClientBase } from "pg";
import type { NotificationDeepLink, NotificationSeverity } from "../../../contracts/notifications/index.js";
import type { EnqueueNotifyDispatch } from "./routing.js";
export interface NotificationInput { readonly workspaceId: string; readonly projectId: string | null; readonly userId: string | null; readonly kind: string; readonly severity: NotificationSeverity; readonly title: string; readonly body: string | null; readonly eventKey: string; readonly deepLink?: NotificationDeepLink | null; readonly taskId?: string | null }
export interface WriteOutcome { readonly id: string | null; readonly created: boolean; readonly emailIds: readonly string[] }
export async function writeNotification(_tx: ClientBase, _input: NotificationInput, _options: { enqueue?: EnqueueNotifyDispatch } = {}): Promise<WriteOutcome> { return { id: null, created: false, emailIds: [] }; }
