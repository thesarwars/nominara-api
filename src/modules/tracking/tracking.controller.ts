import { Controller } from "@nestjs/common";
import { TrackingService } from "./tracking.service.js";

// STORY-022 — scaffold only. This bounded area's own future story adds the
// HTTP surface. A controller resolves the request, calls one service
// method, and returns — no logic here (coding-standards.md §1).
@Controller("tracking")
export class TrackingController {
  constructor(private readonly service: TrackingService) {}
}
