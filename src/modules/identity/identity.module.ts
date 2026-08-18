import { Module } from "@nestjs/common";
import { DbModule } from "../../db/db.module.js";
import { IdentityController } from "./identity.controller.js";
import { IdentityService } from "./identity.service.js";
import { SessionService } from "./session.service.js";

// STORY-014 — IdentityService reaches user_credentials/users/
// webauthn_challenges through @Inject(PG_POOL) directly (coding-standards.md
// §3: no repository layer). DbModule is @Global() but its providers only
// exist once something imports it into the graph.
// STORY-017 — SessionService owns sessions/refresh_tokens the same way.
@Module({
  imports: [DbModule],
  controllers: [IdentityController],
  providers: [IdentityService, SessionService],
})
export class IdentityModule {}
