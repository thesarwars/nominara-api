import { Module } from "@nestjs/common";
import { DbModule } from "../../db/db.module.js";
import { CacheModule } from "../../lib/cache/cache.module.js";
import { TenancyAccessModule } from "../../tenancy/tenancy-access.module.js";
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
// STORY-170 — TenancyAccessModule imported so SessionService can inject
// MembershipService (refresh re-verifies the session's active workspace
// through the SAME instance WorkspaceGuard and WorkspacesService use — see
// tenancy-access.module.ts's own "ONE INSTANCE PER PROCESS" comment). No
// cycle: TenancyAccessModule depends on nothing in this module, and
// WorkspacesModule (which already imports both) is unaffected — Nest caches
// one instance per module class across the whole graph.
// STORY-170 — CacheModule imported EXPLICITLY even though it is @Global(),
// as PromptsModule/TrackingModule do, so this module compiles on its own:
// SessionService keeps the refresh-token grace slot in the shared cache
// (session.service.ts's header says why it is not in Postgres).
@Module({
  imports: [DbModule, CacheModule, TenancyAccessModule],
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
