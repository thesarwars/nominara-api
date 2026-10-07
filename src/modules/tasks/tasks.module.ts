import { Module } from "@nestjs/common";
import { REALTIME_PUBLISHER, RealtimePublisherProvider, type RealtimePublisher } from "../../lib/cache/realtime-publisher.js";
import { TasksController } from "./tasks.controller.js";
import { TasksService } from "./tasks.service.js";

// STORY-022 — system-architecture.md §5 module inventory. Registration
// only — no logic here (coding-standards.md §1's module layout).
//
// STORY-169 (API step 2/3) exports TasksService: `tasks` is this module's
// table to own (coding-standards.md §1), and `GET /v1/workspaces/{id}/
// action-items` lives on WorkspacesController (it joins the existing
// `workspaces/:id/*` cross-resource route family — see that controller's
// own comment), which imports this module for the service rather than
// querying `tasks` itself.
@Module({
  controllers: [TasksController],
  providers: [
    TasksService,
    // STORY-064 (step D) — the same environment-chosen publisher the workspaces
    // module builds; TasksService publishes task.moved / task.created after commit.
    { provide: REALTIME_PUBLISHER, useFactory: (): RealtimePublisher => RealtimePublisherProvider.create() },
  ],
  exports: [TasksService],
})
export class TasksModule {}
