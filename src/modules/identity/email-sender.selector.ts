import { Logger } from "@nestjs/common";
import { loadEnv } from "../../config/env.js";
import { sharedSuppressionStore, type SuppressionStore } from "../../lib/email/suppression-store.js";
import { DevEmailSenderAdapter } from "./adapters/dev-email-sender.adapter.js";
import { LoggingEmailSenderAdapter } from "./adapters/logging-email-sender.adapter.js";
import { ResendEmailSenderAdapter } from "./adapters/resend-email-sender.adapter.js";
import { SuppressingEmailSender, type SuppressingEmailSenderOptions } from "./adapters/suppressing-email-sender.js";
import type { EmailSender } from "./ports/email-sender.js";

const logger = new Logger("email-sender");
let warnedHalfConfig = false;

/**
 * STORY-127 — which EmailSender this process runs with.
 *
 * Group C — Resend wins when RESEND_API_KEY and RESEND_FROM_EMAIL are both set: real delivery was asked for by
 * supplying a credential, and a developer who also left OTP_DEV_LOG_CODES on gets a warning that it is being ignored
 * rather than a silently-unsent code. Otherwise nothing changes.
 *
 * Without Resend, the default is LoggingEmailSenderAdapter in every environment, including
 * development: nothing prints a one-time code unless a developer explicitly
 * asked for it. `env.schema.ts` already refuses OTP_DEV_LOG_CODES under
 * NODE_ENV=production at boot, and DevEmailSenderAdapter's constructor
 * refuses it again — this function is the third place the pair is checked,
 * and deliberately so: it is the one a reader lands on first.
 */
export function selectEmailSender(options: SuppressingEmailSenderOptions & { readonly store?: SuppressionStore } = {}): EmailSender {
  const env = loadEnv();
  // STORY-178 — whichever transport is chosen, it is wrapped: the suppression check is part of THE send path, so every
  // mail kind honours it and no caller can forget to ask. `options.store` is for tests; production reads the shared store lazily.
  return new SuppressingEmailSender(selectTransport(), options.store ?? sharedSuppressionStore(), env.OTP_EMAIL_HASH_PEPPER, {
    ...(options.onLookupFailure !== undefined ? { onLookupFailure: options.onLookupFailure } : {}),
  });
}

function selectTransport(): EmailSender {
  const env = loadEnv();
  if (env.RESEND_API_KEY !== undefined && env.RESEND_FROM_EMAIL !== undefined) {
    if (env.OTP_DEV_LOG_CODES === "true") {
      logger.warn("OTP_DEV_LOG_CODES is ignored: Resend is configured, so codes are delivered by email and never logged.");
    }
    if (env.RESEND_TO_EMAIL !== undefined) {
      logger.warn("RESEND_TO_EMAIL is set: EVERY outgoing email is redirected to that one address (development only).");
    }
    return new ResendEmailSenderAdapter({
      apiKey: env.RESEND_API_KEY,
      from: env.RESEND_FROM_EMAIL,
      ...(env.RESEND_TO_EMAIL !== undefined ? { toOverride: env.RESEND_TO_EMAIL } : {}),
    });
  }
  // Outside production a half-set pair or a lone override is a developer typo, not a refusal: say so once. (Production
  // refuses the half pair and the override at boot, in env.schema.ts.)
  if (!warnedHalfConfig && env.NODE_ENV !== "production") {
    const half = (env.RESEND_API_KEY === undefined) !== (env.RESEND_FROM_EMAIL === undefined);
    if (half || (env.RESEND_TO_EMAIL !== undefined && (env.RESEND_API_KEY === undefined || env.RESEND_FROM_EMAIL === undefined))) {
      warnedHalfConfig = true;
      logger.warn(
        "Resend is only partly configured (needs BOTH RESEND_API_KEY and RESEND_FROM_EMAIL; RESEND_TO_EMAIL does nothing without them): email is NOT being delivered.",
      );
    }
  }
  if (env.OTP_DEV_LOG_CODES === "true" && env.NODE_ENV !== "production") {
    return new DevEmailSenderAdapter();
  }
  return new LoggingEmailSenderAdapter();
}
