import type { NotificationDeepLink, NotificationSeverity } from "../../../contracts/notifications/index.js";
import { deepLinkHref } from "./routing.js";

// STORY-068 — the plain-text email bodies. No template or branding system exists (EmailMessage.htmlBody is unused), so a
// notification email is text: the title, the body and the link to the surface that diagnoses it (AC13).

const SUBJECT_PREFIX = "Nominara";

function linkLine(deepLink: NotificationDeepLink | null, appOrigin: string | undefined): string | null {
  if (deepLink === null) return null;
  const href = deepLinkHref(deepLink);
  return appOrigin === undefined ? href : `${appOrigin.replace(/\/+$/u, "")}${href}`;
}

export function renderImmediateEmail(input: { title: string; body: string | null; deepLink: NotificationDeepLink | null; appOrigin: string | undefined }): {
  subject: string;
  textBody: string;
} {
  const link = linkLine(input.deepLink, input.appOrigin);
  const lines = [input.title, ...(input.body === null ? [] : ["", input.body]), ...(link === null ? [] : ["", `Open: ${link}`])];
  return { subject: `${SUBJECT_PREFIX}: ${input.title}`, textBody: `${lines.join("\n")}\n` };
}

export interface DigestItem {
  readonly title: string;
  readonly body: string | null;
  readonly severity: NotificationSeverity;
  readonly deepLink: NotificationDeepLink | null;
}

const SEVERITY_ORDER: Readonly<Record<NotificationSeverity, number>> = { critical: 0, warning: 1, info: 2 };

/** AC9 — ONE email for the period, every item in it, the most severe first. Never called with nothing to say (AC10). */
export function renderDigestEmail(input: { cadence: "daily" | "weekly"; periodLabel: string; items: readonly DigestItem[]; appOrigin: string | undefined }): {
  subject: string;
  textBody: string;
} {
  if (input.items.length === 0) throw new Error("an empty digest is never rendered (STORY-068 AC10)");
  const items = [...input.items].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  const noun = input.items.length === 1 ? "update" : "updates";
  const cadence = input.cadence === "daily" ? "Daily" : "Weekly";
  const heading = [cadence, " digest, ", input.periodLabel, ": ", String(input.items.length), " ", noun].join("");
  const lines = [heading, ""];
  for (const item of items) {
    lines.push(`- [${item.severity}] ${item.title}`);
    if (item.body !== null) lines.push(`  ${item.body}`);
    const link = linkLine(item.deepLink, input.appOrigin);
    if (link !== null) lines.push(`  ${link}`);
  }
  lines.push("", "Change how often you get this in Settings.");
  return { subject: `${SUBJECT_PREFIX}: ${heading}`, textBody: `${lines.join("\n")}\n` };
}
