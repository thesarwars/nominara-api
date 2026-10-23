// STORY-068 RED stub — replaced by the implementation.
import type { EmailSender } from "../../../modules/identity/ports/email-sender.js";
import type { EnqueueNotifyDispatch } from "../../notifications/routing.js";
import type { QueueHandlerContext } from "../handlers.js";
import type { JobProcessor } from "../worker-factory.js";
export function createNotifyDispatchHandler(_context: QueueHandlerContext, _deps: { sender?: EmailSender; enqueue?: EnqueueNotifyDispatch } = {}): JobProcessor {
  return async () => undefined;
}
