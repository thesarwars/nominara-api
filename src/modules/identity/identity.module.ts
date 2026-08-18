import { Module } from "@nestjs/common";
import { DbModule } from "../../db/db.module.js";
import { IdentityController } from "./identity.controller.js";
import { IdentityService } from "./identity.service.js";

// STORY-014 — IdentityService reaches user_credentials/users/
// webauthn_challenges through @Inject(PG_POOL) directly (coding-standards.md
// §3: no repository layer). DbModule is @Global() but its providers only
// exist once something imports it into the graph.
@Module({
  imports: [DbModule],
  controllers: [IdentityController],
  providers: [IdentityService],
})
export class IdentityModule {}
