import { Module } from "@nestjs/common";
import { DbModule } from "../../db/db.module.js";
import { DevEmailSenderAdapter } from "./adapters/dev-email-sender.adapter.js";
import { LoggingEmailSenderAdapter } from "./adapters/logging-email-sender.adapter.js";
import { loadEnv } from "../../config/env.js";
import { OpenidClientAdapter } from "./adapters/openid-client.adapter.js";
import { EmailOtpController } from "./email-otp.controller.js";
import { EmailOtpService } from "./email-otp.service.js";
import { IdentityController } from "./identity.controller.js";
import { IdentityService } from "./identity.service.js";
import { OauthController } from "./oauth.controller.js";
import { OauthService } from "./oauth.service.js";
import { EMAIL_SENDER, type EmailSender } from "./ports/email-sender.js";
import { OAUTH_CLIENT } from "./ports/oauth-client.js";
import { SessionService } from "./session.service.js";

// STORY-014 — IdentityService reaches user_credentials/users/
// webauthn_challenges through @Inject(PG_POOL) directly (coding-standards.md
// §3: no repository layer). DbModule is @Global() but its providers only
// exist once something imports it into the graph.
// STORY-017 — SessionService owns sessions/refresh_tokens the same way.
// STORY-021 — SessionService exported so WorkspacesModule can inject it for
// POST /workspaces/{id}/switch (mints the new token via the existing
// switchWorkspace seam rather than duplicating token-minting logic).
// STORY-015 — OAUTH_CLIENT's real adapter is registered here; every test
// overrides this provider with a fake at the port boundary
// (test/integration/identity-oauth-pkce.spec.ts), so OpenidClientAdapter
// itself carries zero test coverage from this module.
@Module({
  imports: [DbModule],
  controllers: [IdentityController, OauthController, EmailOtpController],
  providers: [
    IdentityService,
    SessionService,
    OauthService,
    EmailOtpService,
    { provide: OAUTH_CLIENT, useClass: OpenidClientAdapter },
    // STORY-127 — chosen at boot, not hardcoded. DevEmailSenderAdapter logs
    // the one-time code in plaintext so local sign-in is possible at all;
    // it is reachable ONLY with OTP_DEV_LOG_CODES set and NODE_ENV not
    // "production", and its own constructor refuses production as well.
    { provide: EMAIL_SENDER, useFactory: selectEmailSender },
  ],
  exports: [SessionService],
})
export class IdentityModule {}

/**
 * STORY-127 — which EmailSender this process runs with.
 *
 * The default is LoggingEmailSenderAdapter in every environment, including
 * development: nothing prints a one-time code unless a developer explicitly
 * asked for it. `env.schema.ts` already refuses OTP_DEV_LOG_CODES under
 * NODE_ENV=production at boot, and DevEmailSenderAdapter's constructor
 * refuses it again — this function is the third place the pair is checked,
 * and deliberately so: it is the one a reader lands on first.
 */
export function selectEmailSender(): EmailSender {
  const env = loadEnv();
  if (env.OTP_DEV_LOG_CODES === "true" && env.NODE_ENV !== "production") {
    return new DevEmailSenderAdapter();
  }
  return new LoggingEmailSenderAdapter();
}
