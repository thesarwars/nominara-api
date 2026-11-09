import { Module } from "@nestjs/common";
import { QueueProducerModule } from "../../lib/queue/queue-producer.module.js";
import { AuxModule } from "../aux/aux.module.js";
import { AlignmentController } from "./alignment.controller.js";
import { AlignmentService } from "./alignment.service.js";
import { GeoController } from "./geo.controller.js";
import { TasksModule } from "../tasks/tasks.module.js";
import { GeoService } from "./geo.service.js";

// STORY-022 — system-architecture.md §5 module inventory. Registration
// only — no logic here (coding-standards.md §1's module layout).
// STORY-062 AC10: the digest links a lever to its open task through TasksService (`tasks` is that module's table).
// STORY-192: the alignment session's routes. They enqueue (QueueProducerModule) and read a patch back through the module that owns `patches`' reader
// (AuxModule exports AuxService), rather than a second reader of that table.
@Module({
  imports: [TasksModule, QueueProducerModule, AuxModule],
  controllers: [GeoController, AlignmentController],
  providers: [GeoService, AlignmentService],
})
export class GeoModule {}
