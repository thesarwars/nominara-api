import { Controller } from "@nestjs/common";
import { AdminService } from "./admin.service.js";

// STORY-022 — scaffold only. This bounded area's own future story adds the
// HTTP surface. A controller resolves the request, calls one service
// method, and returns — no logic here (coding-standards.md §1).
@Controller("admin")
export class AdminController {
  constructor(private readonly service: AdminService) {}
}
