import { Module } from "@nestjs/common";
import { EntitlementsController } from "./entitlements.controller.js";
import { EntitlementsService } from "./entitlements.service.js";

// STORY-022 — system-architecture.md §5 module inventory. Registration
// only — no logic here (coding-standards.md §1's module layout).
@Module({
  controllers: [EntitlementsController],
  providers: [EntitlementsService],
})
export class EntitlementsModule {}
