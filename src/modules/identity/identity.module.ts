import { Module } from "@nestjs/common";
import { DbModule } from "../../db/db.module.js";
import { LoggingEmailSenderAdapter } from "./adapters/logging-email-sender.adapter.js";
import { OpenidClientAdapter } from "./adapters/openid-client.adapter.js";
import { EmailOtpController } from "./email-otp.controller.js";
import { EmailOtpService } from "./email-otp.service.js";
import { IdentityController } from "./identity.controller.js";
import { IdentityService } from "./identity.service.js";
import { OauthController } from "./oauth.controller.js";
import { OauthService } from "./oauth.service.js";
import { EMAIL_SENDER } from "./ports/email-sender.js";
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
    { provide: EMAIL_SENDER, useClass: LoggingEmailSenderAdapter },
  ],
  exports: [SessionService],
})
export class IdentityModule {}
