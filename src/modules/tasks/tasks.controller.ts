import { Controller } from "@nestjs/common";
import { TasksService } from "./tasks.service.js";

// STORY-022 — scaffold only. This bounded area's own future story adds the
// HTTP surface. A controller resolves the request, calls one service
// method, and returns — no logic here (coding-standards.md §1).
@Controller("tasks")
export class TasksController {
  constructor(private readonly service: TasksService) {}
}
