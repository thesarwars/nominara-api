import { Module } from "@nestjs/common";
import { CommandController } from "./command.controller.js";
import { CommandService } from "./command.service.js";

// STORY-022 — system-architecture.md §5 module inventory. Registration
// only — no logic here (coding-standards.md §1's module layout).
@Module({
  controllers: [CommandController],
  providers: [CommandService],
})
export class CommandModule {}
