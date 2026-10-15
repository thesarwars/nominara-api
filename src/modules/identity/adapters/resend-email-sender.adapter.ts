import { Injectable, Logger } from "@nestjs/common";
import { SpanStatusCode, trace, type Span } from "@opentelemetry/api";
import { loadEnv } from "../../../config/env.js";
import { hashEmailKey, normalizeEmail } from "../../../lib/auth/email-otp.js";
import { uuidV7 } from "../../../lib/ids/uuidv7.js";
import { incrementCounter } from "../../../lib/telemetry/metrics.js";
import type { EmailMessage, EmailSender } from "../ports/email-sender.js";

// Group C — the EMAIL_SENDER port's real transport: Resend's REST API
// (POST https://api.resend.com/emails, Bearer key) over the platform `fetch`. No SDK: one endpoint does not earn a
// dependency, and the fetch is injectable so every test runs against a fake HTTP layer.
//
// WHEN IT RUNS. EmailOtpService defers the send with setImmediate AFTER its uniform-duration floor has settled, and
// auto-top-up sends from a worker job, so the retries and the timeout below add latency to neither (STORY-016
// scenario 3 still holds; see test/integration/identity-email-otp-resend.spec.ts).
//
// Scheduled reports (ScheduledReportsService.sendNow) send AFTER the request transaction commits (migration 0126, delivery
// status `sending`), one recipient at a time, so a slow provider holds no lock and no request connection. The longest a
// delivery can legitimately take is bounded by RESEND_WORST_CASE_SEND_MS x recipients; the service derives its stale-`sending`
// window from that, and a unit test pins it.
//
// FAILURE SEMANTICS. `send` resolves on a 2xx and otherwise rejects with an EmailDeliveryError, which is what the port
// has always meant (callers catch and log). Only a 429, a 5xx, a network error or a timeout is retried, a bounded
// number of times; every other 4xx is the request's own fault and is not repeated. All attempts of ONE send share ONE
// Idempotency-Key (Resend de-duplicates on it for 24 hours), which is what makes retrying a timed-out attempt safe.
//
// REDACTION. Nothing here logs the address, the body, or the key. The recipient appears only as the same peppered
// hash LoggingEmailSenderAdapter logs; Resend's error text is NOT forwarded (it can quote the address back).

const tracer = trace.getTracer("nominara.email");

export const RESEND_ENDPOINT = "https://api.resend.com/emails";
export const RESEND_TIMEOUT_MS = 10_000;
export const RESEND_MAX_ATTEMPTS = 3;
export const RESEND_BACKOFF_BASE_MS = 500;
/** A Retry-After longer than this is not waited out: the send fails and the caller's own retry policy decides. */
export const RESEND_MAX_RETRY_AFTER_MS = 30_000;

/** Largest sleep before retry number `retry` (1-based) from the exponential backoff: the jitter factor is below 1.5. */
export function maxBackoffMs(retry: number): number {
  return Math.ceil(RESEND_BACKOFF_BASE_MS * 2 ** (retry - 1) * 1.5);
}

/**
 * The longest one `send()` can take: every attempt runs to its timeout, and every retry sleeps the larger of the Retry-After
 * cap and the backoff ceiling. (90 s with the current constants.)
 */
export const RESEND_WORST_CASE_SEND_MS =
  RESEND_MAX_ATTEMPTS * RESEND_TIMEOUT_MS +
  Array.from({ length: RESEND_MAX_ATTEMPTS - 1 }, (_, i) => Math.max(RESEND_MAX_RETRY_AFTER_MS, maxBackoffMs(i + 1))).reduce((a, b) => a + b, 0);

export class EmailDeliveryError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly retryable: boolean,
    readonly attempts: number,
  ) {
    super(message);
    this.name = "EmailDeliveryError";
  }
}

export interface ResendEmailSenderOptions {
  readonly apiKey: string;
  /** `address` or `Display Name <address>`. */
  readonly from: string;
  /** DEV-ONLY (RESEND_TO_EMAIL): every message goes here instead of its real recipient. Refused under production. */
  readonly toOverride?: string;
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  /** In [0,1); injectable so the jitter is deterministic in tests. */
  readonly random?: () => number;
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
  readonly endpoint?: string;
}

@Injectable()
export class ResendEmailSenderAdapter implements EmailSender {
  readonly delivers = true;
  private readonly logger = new Logger(ResendEmailSenderAdapter.name);
  private readonly apiKey: string;
  private readonly from: string;
  readonly toOverride: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly endpoint: string;
  private readonly pepper: string;

  constructor(options: ResendEmailSenderOptions) {
    const env = loadEnv();
    // The same posture as DevEmailSenderAdapter: the boot validation already refuses this pair, and the constructor
    // refuses it again, so a refactor of the selector cannot quietly ship a redirect-everything sender to production.
    if (options.toOverride !== undefined && env.NODE_ENV === "production") {
      throw new Error(
        "RESEND_TO_EMAIL redirects every outgoing email to one address and must never be used under NODE_ENV=production.",
      );
    }
    this.apiKey = options.apiKey;
    this.from = options.from;
    this.toOverride = options.toOverride;
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.random = options.random ?? Math.random;
    this.timeoutMs = options.timeoutMs ?? RESEND_TIMEOUT_MS;
    this.maxAttempts = options.maxAttempts ?? RESEND_MAX_ATTEMPTS;
    this.endpoint = options.endpoint ?? RESEND_ENDPOINT;
    this.pepper = env.OTP_EMAIL_HASH_PEPPER;
  }

  send(message: EmailMessage): Promise<void> {
    // One span per send (all attempts inside it). Attributes are the provider, the attempt count and the outcome — never
    // an address, a subject's variable part or a body.
    return tracer.startActiveSpan("email.send", async (span) => {
      span.setAttribute("nominara.email.provider", "resend");
      try {
        await this.deliver(message, span);
        span.setAttribute("nominara.email.outcome", "sent");
      } catch (error) {
        span.setAttribute("nominara.email.outcome", "failed");
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  private async deliver(message: EmailMessage, span: Span): Promise<void> {
    const recipient = this.toOverride ?? message.to;
    const recipientHash = hashEmailKey(normalizeEmail(recipient), this.pepper).toString("hex");
    const idempotencyKey = uuidV7();
    const payload = JSON.stringify({
      from: this.from,
      to: [recipient],
      subject: message.subject,
      text: message.textBody,
      ...(message.htmlBody !== undefined ? { html: message.htmlBody } : {}),
      headers: { "X-Entity-Ref-ID": idempotencyKey },
    });

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const outcome = await this.attempt(payload, idempotencyKey);
      span.setAttribute("nominara.email.attempts", attempt);

      if (outcome.kind === "sent") {
        incrementCounter("nominara_email_send_total", { provider: "resend", outcome: "sent" });
        this.logger.log(
          `email sent provider=resend message_id=${outcome.id} recipient_hash=${recipientHash} template=${message.subject}`,
        );
        return;
      }

      const lastAttempt = attempt === this.maxAttempts;
      const waitMs = outcome.retryable ? this.waitBeforeRetry(attempt, outcome.retryAfterMs) : undefined;
      if (waitMs === undefined || lastAttempt) {
        incrementCounter("nominara_email_send_total", { provider: "resend", outcome: "failed" });
        this.logger.warn(
          `email send failed provider=resend status=${outcome.status ?? "none"} reason=${outcome.reason} attempts=${attempt} ` +
            `retryable=${String(outcome.retryable)} recipient_hash=${recipientHash} template=${message.subject}`,
        );
        throw new EmailDeliveryError(
          `email delivery failed (resend, ${outcome.reason}${outcome.status !== undefined ? `, status ${outcome.status}` : ""}, after ${attempt} attempt${attempt === 1 ? "" : "s"})`,
          outcome.status,
          outcome.retryable,
          attempt,
        );
      }

      incrementCounter("nominara_email_send_retry_total", { provider: "resend" });
      this.logger.warn(
        `email send retrying provider=resend status=${outcome.status ?? "none"} reason=${outcome.reason} attempt=${attempt} wait_ms=${waitMs}`,
      );
      await this.sleep(waitMs);
    }
    // Unreachable: the loop always returns or throws on its last attempt. Fail closed if maxAttempts was < 1.
    throw new EmailDeliveryError("email delivery failed (resend, no attempt was made)", undefined, false, 0);
  }

  private async attempt(payload: string, idempotencyKey: string): Promise<AttemptOutcome> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
          "User-Agent": "nominara-api",
        },
        body: payload,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      return { kind: "failed", status: undefined, retryable: true, reason: timedOut ? "timed out" : "network error" };
    }

    if (response.ok) {
      const id = await response
        .json()
        .then((body: unknown) => (typeof (body as { id?: unknown })?.id === "string" ? (body as { id: string }).id : "unknown"))
        .catch(() => "unknown");
      return { kind: "sent", id };
    }

    // A 409 `concurrent_idempotent_requests` means our own earlier attempt (same Idempotency-Key) is still in flight at
    // Resend: wait and retry, the retry will return that attempt's result. Any other 409 is a real conflict.
    const concurrentIdempotent = response.status === 409 && (await errorNameOf(response)) === "concurrent_idempotent_requests";
    // Release the connection without reading a body we do not need.
    await response.body?.cancel().catch(() => {});
    const retryable = response.status === 429 || response.status >= 500 || concurrentIdempotent;
    return {
      kind: "failed",
      status: response.status,
      retryable,
      reason: `http ${response.status}`,
      retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after")),
    };
  }

  /** The delay before the next attempt, or undefined when the server asked for a wait longer than we will hold a worker. */
  private waitBeforeRetry(attempt: number, retryAfterMs: number | undefined): number | undefined {
    if (retryAfterMs !== undefined) {
      return retryAfterMs <= RESEND_MAX_RETRY_AFTER_MS ? retryAfterMs : undefined;
    }
    const exponential = RESEND_BACKOFF_BASE_MS * 2 ** (attempt - 1);
    return Math.round(exponential * (0.5 + this.random()));
  }
}

type AttemptOutcome =
  | { kind: "sent"; id: string }
  | { kind: "failed"; status: number | undefined; retryable: boolean; reason: string; retryAfterMs?: number | undefined };

/** The `name` Resend puts in an error body, or undefined if the body is not that shape. Read only for a 409. */
async function errorNameOf(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { name?: unknown };
    return typeof body.name === "string" ? body.name : undefined;
  } catch {
    return undefined;
  }
}

/** Retry-After is delay-seconds or an HTTP date; anything unparseable is treated as absent. */
function parseRetryAfterMs(header: string | null): number | undefined {
  if (header === null) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}
