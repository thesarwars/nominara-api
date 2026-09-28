import { Module } from "@nestjs/common";
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
  providers: [TasksService],
  exports: [TasksService],
})
export class TasksModule {}
