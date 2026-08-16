import { Module } from "@nestjs/common";
import { DisplacementController } from "./displacement.controller.js";
import { DisplacementService } from "./displacement.service.js";

// STORY-022 — system-architecture.md §5 module inventory. Registration
// only — no logic here (coding-standards.md §1's module layout).
@Module({
  controllers: [DisplacementController],
  providers: [DisplacementService],
})
export class DisplacementModule {}
