import { Module } from "@nestjs/common";
import { CreditsController } from "./credits.controller.js";
import { CreditsService } from "./credits.service.js";

// STORY-022 — system-architecture.md §5 module inventory. Registration
// only — no logic here (coding-standards.md §1's module layout).
@Module({
  controllers: [CreditsController],
  providers: [CreditsService],
})
export class CreditsModule {}
