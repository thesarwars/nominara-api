import { Logger, type OnModuleDestroy } from "@nestjs/common";
import { loadEnv } from "../../config/env.js";
import { ResendEmailSenderAdapter } from "../../modules/identity/adapters/resend-email-sender.adapter.js";
import { selectEmailSender } from "../../modules/identity/email-sender.selector.js";
import { EmailAlertAdapter } from "./email-alert.adapter.js";

// Group C item 2 — the process-wide alert emailer. Pager call sites are plain functions and classes outside Nest DI
// (DlqDepthMonitor, BlackoutMonitor, ParseAlertMonitor, the verifier scripts), so they reach the emailer through this
// lazily-built singleton rather than an injected provider.
//
// ALERT_EMAIL_TO unset => there is no emailer: every alert keeps exactly the log line and counter it always had, and
// ONE warning says so (announceAlertRouting, called at boot; also on first use for a process that never boots through
// main/worker, like the verifier scripts).

const logger = new Logger("alerts");

let resolved: EmailAlertAdapter | null | undefined;

export function getAlertEmailer(): EmailAlertAdapter | null {
  if (resolved !== undefined) return resolved;
  const env = loadEnv();
  if (env.ALERT_EMAIL_TO === undefined) {
    logger.warn("ALERT_EMAIL_TO is not set: operational alerts are logged and counted only, and nobody is emailed.");
    resolved = null;
  } else {
    const sender = selectEmailSender();
    const delivers = sender instanceof ResendEmailSenderAdapter;
    if (delivers) {
      // The address is configuration, but this line names the setting, not the value.
      logger.log("operational alerts are emailed to ALERT_EMAIL_TO through Resend.");
    } else {
      // Production refuses this combination at boot (env.schema.ts); here it is a developer's machine.
      logger.warn(
        "ALERT_EMAIL_TO is set but Resend is not configured (RESEND_API_KEY + RESEND_FROM_EMAIL): alerts are NOT delivered, only logged and counted as not_delivered.",
      );
    }
    resolved = new EmailAlertAdapter({ sender, to: env.ALERT_EMAIL_TO, environment: env.NODE_ENV, delivers });
  }
  return resolved;
}

/** Call at process boot so the "alerts go nowhere" line is in the boot log, not discovered on the first incident. */
export function announceAlertRouting(): void {
  getAlertEmailer();
}

/**
 * The emailer, or null when it cannot be built. An alert path must never replace the failure it is reporting: if the
 * environment will not load here, the page still has its log line and counter, and THIS failure is logged loudly
 * (naming the error class only) rather than thrown into the verifier or monitor that raised the page. Not memoised, so
 * the next page tries again.
 */
function emailerOrNull(): EmailAlertAdapter | null {
  try {
    return getAlertEmailer();
  } catch (error) {
    logger.error(`alert email unavailable, this page was not emailed: ${error instanceof Error ? error.name : "unknown error"}`);
    return null;
  }
}

/** The email leg of a sync `Pager` page. A no-op when alerts are not configured. */
export function emailAlert(message: string, context: Record<string, unknown>): void {
  emailerOrNull()?.page(message, context);
}

/** The email leg for the async verifier ports: resolves once the mail has settled (the scripts exit right after). */
export async function emailAlertAndWait(message: string, context: Record<string, unknown>): Promise<void> {
  await emailerOrNull()?.notify(message, context);
}

/** Test seam: install (or clear, with `undefined`, to re-read the environment) the process emailer. */
export function setAlertEmailerForTests(emailer: EmailAlertAdapter | null | undefined): void {
  resolved = emailer;
}

/** How long shutdown waits for in-flight alert emails before giving up on them. */
export const ALERT_DRAIN_TIMEOUT_MS = 5_000;

/** Waits (bounded) for in-flight alert emails to settle. Never rejects; a hung provider cannot hold shutdown. */
export async function drainAlertEmails(timeoutMs: number = ALERT_DRAIN_TIMEOUT_MS): Promise<void> {
  if (resolved === undefined || resolved === null) return;
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      logger.warn("alert email drain timed out; unsent alerts are dropped");
      resolve();
    }, timeoutMs);
  });
  try {
    await Promise.race([resolved.drain().catch(() => undefined), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** Registered in the API module so a graceful shutdown flushes pending alert mail (the worker calls drainAlertEmails itself). */
export class AlertEmailShutdown implements OnModuleDestroy {
  async onModuleDestroy(): Promise<void> {
    await drainAlertEmails();
  }
}
