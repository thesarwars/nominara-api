import { Logger } from "@nestjs/common";
import { loadEnv } from "../../config/env.js";
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
    // The address is configuration, but this line names the setting, not the value.
    logger.log("operational alerts are emailed to ALERT_EMAIL_TO through the configured EMAIL_SENDER.");
    resolved = new EmailAlertAdapter({ sender: selectEmailSender(), to: env.ALERT_EMAIL_TO, environment: env.NODE_ENV });
  }
  return resolved;
}

/** Call at process boot so the "alerts go nowhere" line is in the boot log, not discovered on the first incident. */
export function announceAlertRouting(): void {
  getAlertEmailer();
}

/** The email leg of a sync `Pager` page. A no-op when alerts are not configured. */
export function emailAlert(message: string, context: Record<string, unknown>): void {
  getAlertEmailer()?.page(message, context);
}

/** The email leg for the async verifier ports: resolves once the mail has settled (the scripts exit right after). */
export async function emailAlertAndWait(message: string, context: Record<string, unknown>): Promise<void> {
  await getAlertEmailer()?.notify(message, context);
}

/** Test seam: install (or clear, with `undefined`, to re-read the environment) the process emailer. */
export function setAlertEmailerForTests(emailer: EmailAlertAdapter | null | undefined): void {
  resolved = emailer;
}
