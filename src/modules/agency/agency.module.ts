import { Module } from "@nestjs/common";
import { AgencyController } from "./agency.controller.js";
import { AgencyService } from "./agency.service.js";

// STORY-022 — system-architecture.md §5 module inventory. Registration
// only — no logic here (coding-standards.md §1's module layout).
@Module({
  controllers: [AgencyController],
  providers: [AgencyService],
})
export class AgencyModule {}
