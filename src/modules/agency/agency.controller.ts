import { Controller } from "@nestjs/common";
import { AgencyService } from "./agency.service.js";

// STORY-022 — scaffold only. This bounded area's own future story adds the
// HTTP surface. A controller resolves the request, calls one service
// method, and returns — no logic here (coding-standards.md §1).
@Controller("agency")
export class AgencyController {
  constructor(private readonly service: AgencyService) {}
}
