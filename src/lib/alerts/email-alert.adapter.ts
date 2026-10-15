import { Logger } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { EmailSender } from "../../modules/identity/ports/email-sender.js";
import type { Pager } from "../queue/dead-letter.js";
import { incrementCounter } from "../telemetry/metrics.js";

// Group C item 2 — operational alerts by email. Owner decision (2026-10-15): no separate paging service; an alert is
// an email through the SAME EMAIL_SENDER port the OTP and report emails use (Resend in any deployment that configures
// it), to the one address in ALERT_EMAIL_TO.
//
// This implements the existing `Pager` port (src/lib/queue/dead-letter.ts) — the seam DlqDepthMonitor,
// BlackoutMonitor and ParseAlertMonitor already call. The audit-chain and wallet verifiers have their own ports
// (PagingNotifier, WalletPagingNotifier) and reach this through `notify`.
//
// ⚠ WHAT AN ALERT MAY CARRY. IDs, counts, rates and enum-like reasons — never prompt text, engine text, an email
// address or a name. `renderAlertEmail` enforces it rather than trusting every call site: a string value survives only
// under a key on SAFE_STRING_KEYS, and any `@`-bearing text is redacted wherever it appears.
//
// ⚠ DEDUPLICATION IS PER PROCESS, AND THAT IS A LIMIT. A page for the same (alert, subject) inside the cooldown is
// dropped, so one sustained condition is one email per window rather than one per tick. The map lives in this
// process's memory — the same trade the parse and blackout monitors already make for their own cooldowns — so N worker
// replicas can each send one email per window and a restart forgets the window. The cache port (`set` with
// `onlyIfAbsent` and a TTL, src/lib/cache/cache.port.ts) is the Valkey-backed upgrade when that stops being
// acceptable; it was not taken now because these callers are plain functions outside Nest DI, with no cache handle.
//
// ⚠ A FAILED SEND RELEASES ITS CLAIM. If the mail did not go, the next occurrence must try again rather than be
// swallowed by a cooldown for an email nobody received.
//
// ⚠ THE COOLDOWN IS NOT IN ANY REFERENCE. 6 hours matches the parser alerts' own ALERT_COOLDOWN_MS; the blackout
// monitor's 24 hours and the DLQ monitor's once-per-breach sit above/below it on their own. Named for the owner to move.

export const ALERT_EMAIL_COOLDOWN_MS = 6 * 60 * 60 * 1000;
/**
 * At most this many emails per alert NAME per cooldown window, across all subjects: a verifier run that finds a hundred
 * broken workspaces sends five emails and a "N more suppressed" line, not a hundred. Not from a reference; named for the
 * owner to move.
 */
export const ALERT_EMAIL_MAX_PER_NAME_PER_WINDOW = 5;
const MAX_TRACKED_KEYS = 1000;
const MAX_VALUE_LENGTH = 200;

/** String-valued context keys that are identifiers or closed vocabularies, never free text. */
const SAFE_STRING_KEYS: ReadonlySet<string> = new Set([
  "alert",
  "alertName",
  "queue",
  "engineKey",
  "workspaceId",
  "seq",
  "reason",
  "table",
  "partition",
]);

const tracer = trace.getTracer("nominara.alerts");
const logger = new Logger("alerts");

export interface AlertEmailAdapterOptions {
  readonly sender: EmailSender;
  /** ALERT_EMAIL_TO. */
  readonly to: string;
  readonly clock?: () => number;
  readonly cooldownMs?: number;
  readonly maxPerNamePerWindow?: number;
  /**
   * Whether `sender` really delivers mail (Resend). False for the logging and dev senders: the alert is then counted as
   * `not_delivered`, never `sent`, and never logged as emailed.
   */
  readonly delivers: boolean;
  /** Shown in the body so an alert from staging is not mistaken for production. */
  readonly environment?: string;
}

export interface RenderedAlert {
  readonly name: string;
  readonly subjectId: string;
  readonly subject: string;
  readonly textBody: string;
}

const EMAIL_LIKE = /[^\s<>"']+@[^\s<>"']+/g;

function scrub(text: string): string {
  return text.replace(EMAIL_LIKE, "[redacted]").slice(0, MAX_VALUE_LENGTH);
}

function nameOf(message: string, context: Record<string, unknown>): string {
  const named = context.alertName ?? context.alert;
  return typeof named === "string" && named.length > 0 ? scrub(named) : `unnamed:${scrub(message)}`;
}

function subjectIdOf(context: Record<string, unknown>): string {
  for (const key of ["workspaceId", "queue", "engineKey"]) {
    const value = context[key];
    if (typeof value === "string" && value.length > 0) return scrub(value);
  }
  return "-";
}

/** Pure: the alert's key, subject line and body. Exported for the redaction tests. */
export function renderAlertEmail(
  message: string,
  context: Record<string, unknown>,
  environment: string,
  at: Date,
): RenderedAlert {
  const name = nameOf(message, context);
  const subjectId = subjectIdOf(context);
  const details = Object.entries(context)
    .filter(([key]) => key !== "alertName")
    .map(([key, value]) => {
      if (typeof value === "number" || typeof value === "boolean") return `  ${key}: ${String(value)}`;
      if (typeof value === "string" && SAFE_STRING_KEYS.has(key)) return `  ${key}: ${scrub(value)}`;
      return `  ${key}: [omitted]`;
    });
  const textBody = [
    `Nominara operational alert: ${name}`,
    "",
    scrub(message),
    "",
    "Details:",
    ...(details.length > 0 ? details : ["  (none)"]),
    "",
    `Environment: ${environment}`,
    `Raised at: ${at.toISOString()}`,
  ].join("\n");
  return { name, subjectId, subject: `[Nominara alert] ${name}${subjectId === "-" ? "" : ` (${subjectId})`}`, textBody };
}

export class EmailAlertAdapter implements Pager {
  private readonly sender: EmailSender;
  private readonly to: string;
  private readonly clock: () => number;
  private readonly cooldownMs: number;
  private readonly environment: string;
  private readonly delivers: boolean;
  private readonly maxPerName: number;
  private readonly perName = new Map<string, { windowEndsAt: number; count: number; suppressed: number }>();
  private readonly claimedUntil = new Map<string, number>();
  private readonly pending = new Set<Promise<void>>();

  constructor(options: AlertEmailAdapterOptions) {
    this.sender = options.sender;
    this.to = options.to;
    this.clock = options.clock ?? Date.now;
    this.cooldownMs = options.cooldownMs ?? ALERT_EMAIL_COOLDOWN_MS;
    this.environment = options.environment ?? "unknown";
    this.delivers = options.delivers;
    this.maxPerName = options.maxPerNamePerWindow ?? ALERT_EMAIL_MAX_PER_NAME_PER_WINDOW;
  }

  /** The synchronous `Pager` port: fire and forget. A send failure is counted and logged, never thrown into the caller. */
  page(message: string, context: Record<string, unknown>): void {
    void this.notify(message, context);
  }

  /**
   * Sends (or suppresses) one alert and resolves when that is settled. Never rejects: an alert path must not be able to
   * fail the verifier or monitor that raised it.
   */
  notify(message: string, context: Record<string, unknown>): Promise<void> {
    const work = this.dispatch(message, context).finally(() => this.pending.delete(work));
    this.pending.add(work);
    return work;
  }

  /** Resolves when every in-flight send has settled. For shutdown and for tests. */
  async drain(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
    this.flushSuppressed(this.clock(), true);
  }

  /** One "N more suppressed" line per alert name whose window has ended (or at drain), then forget the tally. */
  private flushSuppressed(now: number, all: boolean): void {
    for (const [name, tally] of this.perName) {
      if (tally.suppressed > 0 && (all || now >= tally.windowEndsAt)) {
        logger.warn(`alert email cap: ${tally.suppressed} more suppressed name=${name}`);
        tally.suppressed = 0;
      }
      if (now >= tally.windowEndsAt) this.perName.delete(name);
    }
  }

  private async dispatch(message: string, context: Record<string, unknown>): Promise<void> {
    const now = this.clock();
    const rendered = renderAlertEmail(message, context, this.environment, new Date(now));
    const key = `${rendered.name}:${rendered.subjectId}`;

    const until = this.claimedUntil.get(key);
    if (until !== undefined && now < until) {
      incrementCounter("nominara_alerts_email_total", { outcome: "suppressed" });
      return;
    }

    this.flushSuppressed(now, false);
    let tally = this.perName.get(rendered.name);
    if (tally === undefined) {
      tally = { windowEndsAt: now + this.cooldownMs, count: 0, suppressed: 0 };
      this.perName.set(rendered.name, tally);
    }
    if (tally.count >= this.maxPerName) {
      if (tally.suppressed === 0) {
        logger.warn(`alert email cap reached name=${rendered.name} (${this.maxPerName} per window): further emails for it are suppressed`);
      }
      tally.suppressed += 1;
      incrementCounter("nominara_alerts_email_total", { outcome: "suppressed" });
      return;
    }
    tally.count += 1;
    const counted = tally;
    this.claimedUntil.set(key, now + this.cooldownMs);
    this.prune(now);

    await tracer.startActiveSpan("alerts.email", async (span) => {
      span.setAttribute("nominara.alerts.name", rendered.name);
      try {
        await this.sender.send({ to: this.to, subject: rendered.subject, textBody: rendered.textBody });
        if (this.delivers) {
          span.setAttribute("nominara.alerts.outcome", "sent");
          incrementCounter("nominara_alerts_email_total", { outcome: "sent" });
          logger.log(`alert emailed name=${rendered.name} subject_id=${rendered.subjectId}`);
        } else {
          // The sender accepted it and delivered it to nobody (logging/dev sender). Never "sent".
          span.setAttribute("nominara.alerts.outcome", "not_delivered");
          incrementCounter("nominara_alerts_email_total", { outcome: "not_delivered" });
          logger.error(`alert NOT delivered (no email provider configured) name=${rendered.name} subject_id=${rendered.subjectId}`);
        }
      } catch (error) {
        this.claimedUntil.delete(key);
        counted.count -= 1;
        span.setAttribute("nominara.alerts.outcome", "failed");
        span.setStatus({ code: SpanStatusCode.ERROR });
        incrementCounter("nominara_alerts_email_total", { outcome: "failed" });
        logger.error(
          `alert email failed name=${rendered.name} subject_id=${rendered.subjectId} error=${error instanceof Error ? error.name : "unknown"}`,
        );
      } finally {
        span.end();
      }
    });
  }

  private prune(now: number): void {
    if (this.claimedUntil.size <= MAX_TRACKED_KEYS) return;
    for (const [key, until] of this.claimedUntil) {
      if (until <= now) this.claimedUntil.delete(key);
    }
  }
}
