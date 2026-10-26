import { Inject, Injectable, Logger } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { Pool } from "pg";
import { resendWebhookEventSchema, type ResendWebhookEvent, type ResendWebhookResponse } from "../../../contracts/identity/resend-webhook.schema.js";
import { DegradedError, ValidationFailedError } from "../../api/errors/domain-errors.js";
import { loadEnv } from "../../config/env.js";
import { PG_POOL } from "../../db/pg-pool.js";
import { hashEmailKey, normalizeEmail } from "../../lib/auth/email-otp.js";
import { SvixSignatureError, verifySvixSignature } from "../../lib/email/svix-signature.js";
import { uuidV7 } from "../../lib/ids/uuidv7.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";

// STORY-178 — the Resend webhook's ingress. The order below is the design:
//
//   1. configured?            no  -> 503 degraded (the API boots without it; nothing is read or written)
//   2. verify the signature   bad -> 400, nothing written. It runs over the RAW bytes BEFORE the body is parsed or read
//   3. parse the envelope     not JSON / wrong shape -> 400 (a valid signature vouches for the bytes, not for the shape)
//   4. act on the event       hard bounce -> `bounce`; complaint -> `complaint`; anything else is acknowledged and ignored
//   5. record, once           INSERT ... ON CONFLICT (provider_event_id, recipient_hash) DO NOTHING: a redelivered event is a no-op
//
// WHAT NEVER SUPPRESSES (owner decision 8): a transient or undetermined bounce, a delivery delay. They are a metric only,
// because a mailbox that is merely full or a server that is merely down must not lock a person out of their own sign-in code.
//
// NOTHING IS TENANT-SCOPED HERE. A bounce is a property of the address; Resend knows no workspace. The table is GLOBAL and
// holds the peppered hash only. Telling the workspaces whose scheduled reports include the address is the report worker's job
// (it can see across tenants; this door cannot and must not): the row is written with `fanned_out_at` NULL and the sweep
// picks it up (src/lib/email/suppression-fanout.ts).
//
// REDACTION. The address is hashed in memory and goes no further: not into the table, a log line, a span or a metric label,
// and Resend's own bounce text (which quotes the address back) is never logged.

const tracer = trace.getTracer("nominara.email");

type RecordedKind = "bounce" | "complaint";

@Injectable()
export class ResendWebhookService {
  private readonly logger = new Logger(ResendWebhookService.name);

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async handle(
    rawBody: Buffer | undefined,
    headers: { readonly id: string | undefined; readonly timestamp: string | undefined; readonly signature: string | undefined },
  ): Promise<ResendWebhookResponse> {
    const env = loadEnv();
    if (env.RESEND_WEBHOOK_SECRET === undefined) {
      incrementCounter("nominara_email_webhook_events_total", { outcome: "not_configured" });
      throw new DegradedError({ message: "email webhook is not configured" });
    }

    try {
      if (rawBody === undefined) throw new SvixSignatureError("the request has no body");
      verifySvixSignature({ secret: env.RESEND_WEBHOOK_SECRET, id: headers.id, timestamp: headers.timestamp, signatureHeader: headers.signature, body: rawBody });
    } catch (error) {
      if (!(error instanceof SvixSignatureError)) throw error;
      incrementCounter("nominara_email_webhook_events_total", { outcome: "bad_signature" });
      this.logger.warn("resend webhook refused: signature did not verify");
      throw new ValidationFailedError({
        message: "webhook signature verification failed",
        details: { issues: [{ path: ["svix-signature"], message: "signature verification failed" }] },
      });
    }

    const event = this.parse(rawBody);
    const response = await tracer.startActiveSpan("email.suppression.record", async (span) => {
      try {
        const result = await this.dispatch(event, headers.id!, env.OTP_EMAIL_HASH_PEPPER);
        span.setAttribute("nominara.email.webhook.outcome", result.outcome);
        return result;
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
    incrementCounter("nominara_email_webhook_events_total", { outcome: response.outcome });
    return response;
  }

  private parse(rawBody: Buffer): ResendWebhookEvent {
    let json: unknown;
    try {
      json = JSON.parse(rawBody.toString("utf8"));
    } catch {
      throw this.malformed();
    }
    const parsed = resendWebhookEventSchema.safeParse(json);
    if (!parsed.success) throw this.malformed();
    return parsed.data;
  }

  private malformed(): Error {
    this.logger.warn("resend webhook refused: the body is not a Resend event envelope");
    return new ValidationFailedError({ message: "the webhook body is not a Resend event", details: { issues: [{ path: ["body"], message: "not a Resend event envelope" }] } });
  }

  private async dispatch(event: ResendWebhookEvent, eventId: string, pepper: string): Promise<ResendWebhookResponse> {
    const kind = this.kindOf(event);
    if (kind === undefined) return { received: true, outcome: "ignored" };

    const hashes = new Map<string, Buffer>();
    for (const address of event.data.to ?? []) {
      const normalized = normalizeEmail(address);
      if (normalized === "") continue;
      const hash = hashEmailKey(normalized, pepper);
      hashes.set(hash.toString("hex"), hash);
    }
    if (hashes.size === 0) return { received: true, outcome: "ignored" };

    let created = 0;
    for (const [hex, hash] of hashes) {
      const inserted = await this.pool.query<{ id: string }>(
        `INSERT INTO email_suppressions (id, recipient_hash, kind, provider_event_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (provider_event_id, recipient_hash) DO NOTHING
         RETURNING id`,
        [uuidV7(), hash, kind, eventId],
      );
      if ((inserted.rowCount ?? 0) === 0) continue;
      created += 1;
      incrementCounter("nominara_email_suppressions_total", { kind });
      this.logger.log(`email suppression recorded kind=${kind} recipient_hash=${hex}`);
    }
    return { received: true, outcome: created > 0 ? "suppressed" : "duplicate" };
  }

  /**
   * `bounce` only for a PERMANENT bounce; `complaint` for a spam complaint. Everything softer is counted and dropped here, so it
   * cannot suppress by accident later. Resend's bounce types are Permanent, Transient and Undetermined.
   */
  private kindOf(event: ResendWebhookEvent): RecordedKind | undefined {
    if (event.type === "email.complained") return "complaint";
    if (event.type === "email.bounced") {
      const type = event.data.bounce?.type?.toLowerCase();
      if (type === "permanent") return "bounce";
      incrementCounter("nominara_email_soft_bounces_total", { type: type === "transient" || type === "undetermined" ? type : "other" });
      return undefined;
    }
    if (event.type === "email.delivery_delayed") incrementCounter("nominara_email_soft_bounces_total", { type: "delayed" });
    return undefined;
  }
}
