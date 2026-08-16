import { Module } from "@nestjs/common";
import { TrackingController } from "./tracking.controller.js";
import { TrackingService } from "./tracking.service.js";

// STORY-022 — system-architecture.md §5 module inventory. Registration
// only — no logic here (coding-standards.md §1's module layout).
@Module({
  controllers: [TrackingController],
  providers: [TrackingService],
})
export class TrackingModule {}
