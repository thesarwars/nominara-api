import { Controller } from "@nestjs/common";
import { CommandService } from "./command.service.js";

// STORY-022 — scaffold only. This bounded area's own future story adds the
// HTTP surface. A controller resolves the request, calls one service
// method, and returns — no logic here (coding-standards.md §1).
@Controller("command")
export class CommandController {
  constructor(private readonly service: CommandService) {}
}
