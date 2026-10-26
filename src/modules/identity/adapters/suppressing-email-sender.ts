import { Logger } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { hashEmailKey, normalizeEmail } from "../../../lib/auth/email-otp.js";
import type { SuppressionKind, SuppressionStore } from "../../../lib/email/suppression-store.js";
import { incrementCounter } from "../../../lib/telemetry/metrics.js";
import { EmailSuppressedError, EmailSuppressionLookupError, type EmailMessage, type EmailSender } from "../ports/email-sender.js";

// STORY-178 AC3 — the suppression check, INSIDE the single send path. `selectEmailSender()` wraps whatever transport it picks
// in this, so every mail kind that reaches the EMAIL_SENDER port honours it: the sign-in code, scheduled reports (send-now and
// cadence), digests and immediate notifications, the billing notices and the operator alerts. There is no second path to check.
//
// THE RULE (owner decision 8, 2026-10-26)
//   an active BOUNCE     refuses all mail, a transactional one (the sign-in code) included: it could not be delivered
//   an active COMPLAINT  refuses non-transactional mail only: a person who hit "spam" on a report can still sign in
// A transient bounce or a delivery delay never becomes a suppression (the webhook records a metric only), so it cannot get here.
//
// THE SIGN-IN CODE AND ENUMERATION (STORY-016). This runs inside `EmailOtpService`'s existing `setImmediate` deferred send,
// after the request has already returned its fixed-shape response: a suppressed address makes the request neither faster nor
// slower, and the status and body are the same. That is why the check lives here and not in the request path.
//
// FAIL CLOSED. If the list cannot be read, nothing is sent and the caller sees an EmailSuppressionLookupError (its callers
// already treat any rejection as "not sent"): sending to a bounced address is the harm this exists to stop, and a database
// that cannot answer is one every sender is about to fail on anyway.
//
// REDACTION. The address never appears in an error, a log line, a span or a metric label: the peppered hash (the same one the
// adapters log) and the kind only.

const tracer = trace.getTracer("nominara.email");
const logger = new Logger("email-suppression");

export interface SuppressingEmailSenderOptions {
  /**
   * What to do when the suppression list cannot be read. `refuse` (the default, and the rule for every message a person
   * receives) fails closed. `send` is for the OPERATOR ALERT emailer alone: a page that says "the database is down" must not
   * be silenced by the database being down, and its recipient is a platform-owned address, so the cost of mailing it once
   * without the check is nil. The lookup failure is still counted and logged either way.
   */
  readonly onLookupFailure?: "refuse" | "send";
}

export class SuppressingEmailSender implements EmailSender {
  /** The wrapped transport (what `selectEmailSender` chose), for a test or a diagnostic that needs to know which. */
  readonly transport: EmailSender;
  /** Forwarded from the wrapped transport: a caller's `delivered` versus `logged` honesty rule depends on what it really is. */
  readonly delivers?: boolean;

  constructor(
    inner: EmailSender,
    private readonly store: SuppressionStore,
    private readonly pepper: string,
    private readonly options: SuppressingEmailSenderOptions = {},
  ) {
    this.transport = inner;
    if (inner.delivers !== undefined) this.delivers = inner.delivers;
  }

  async send(message: EmailMessage): Promise<void> {
    const blocked = await this.check(message);
    if (blocked !== undefined) throw new EmailSuppressedError(blocked);
    await this.transport.send(message);
  }

  private async check(message: EmailMessage): Promise<SuppressionKind | undefined> {
    const recipientHash = hashEmailKey(normalizeEmail(message.to), this.pepper);
    return await tracer.startActiveSpan("email.suppression.check", async (span) => {
      try {
        let kinds: readonly SuppressionKind[];
        try {
          kinds = await this.store.activeKinds(recipientHash);
        } catch {
          span.setAttribute("nominara.email.suppression.outcome", "lookup_failed");
          span.setStatus({ code: SpanStatusCode.ERROR });
          incrementCounter("nominara_email_suppression_lookups_failed_total");
          if (this.options.onLookupFailure === "send") {
            logger.error(`email suppression lookup failed: sending anyway (operator alert) recipient_hash=${recipientHash.toString("hex")}`);
            return undefined;
          }
          logger.error(`email suppression lookup failed: the send was refused (fail closed) recipient_hash=${recipientHash.toString("hex")}`);
          throw new EmailSuppressionLookupError();
        }
        const blocking: SuppressionKind | undefined = kinds.includes("bounce")
          ? "bounce"
          : message.transactional !== true && kinds.includes("complaint")
            ? "complaint"
            : undefined;
        span.setAttribute("nominara.email.suppression.outcome", blocking === undefined ? "allowed" : "suppressed");
        if (blocking !== undefined) {
          incrementCounter("nominara_email_sends_suppressed_total", { kind: blocking });
          logger.warn(`email not sent: recipient suppressed kind=${blocking} recipient_hash=${recipientHash.toString("hex")} transactional=${String(message.transactional === true)}`);
        }
        return blocking;
      } finally {
        span.end();
      }
    });
  }
}
