import { Module } from "@nestjs/common";
import { PromptsController } from "./prompts.controller.js";
import { PromptsService } from "./prompts.service.js";

// STORY-022 — system-architecture.md §5 module inventory. Registration
// only — no logic here (coding-standards.md §1's module layout).
@Module({
  controllers: [PromptsController],
  providers: [PromptsService],
})
export class PromptsModule {}
