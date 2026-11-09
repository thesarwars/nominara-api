import { Module } from "@nestjs/common";
import { CacheModule } from "../../lib/cache/cache.module.js";
import { EntitlementsModule } from "../entitlements/entitlements.module.js";
import { TasksModule } from "../tasks/tasks.module.js";
import { TrackingModule } from "../tracking/tracking.module.js";
import { CommandController } from "./command.controller.js";
import { CommandExecuteService } from "./command-execute.service.js";
import { CommandService } from "./command.service.js";
import { EntityIndexService } from "./entity-index.service.js";

// STORY-022 - system-architecture.md section 5 module inventory. Registration
// only - no logic here (coding-standards.md section 1's module layout).
// STORY-085 execute imports the two owning services it calls (tasks, the run lifecycle): the bar writes through
// them and never to their tables.
@Module({
  imports: [CacheModule, EntitlementsModule, TasksModule, TrackingModule],
  controllers: [CommandController],
  providers: [CommandService, CommandExecuteService, EntityIndexService],
})
export class CommandModule {}
