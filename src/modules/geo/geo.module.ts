import { Module } from "@nestjs/common";
import { GeoController } from "./geo.controller.js";
import { TasksModule } from "../tasks/tasks.module.js";
import { GeoService } from "./geo.service.js";

// STORY-022 — system-architecture.md §5 module inventory. Registration
// only — no logic here (coding-standards.md §1's module layout).
// STORY-062 AC10: the digest links a lever to its open task through TasksService (`tasks` is that module's table).
@Module({
  imports: [TasksModule],
  controllers: [GeoController],
  providers: [GeoService],
})
export class GeoModule {}
