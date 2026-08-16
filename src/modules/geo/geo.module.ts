import { Module } from "@nestjs/common";
import { GeoController } from "./geo.controller.js";
import { GeoService } from "./geo.service.js";

// STORY-022 — system-architecture.md §5 module inventory. Registration
// only — no logic here (coding-standards.md §1's module layout).
@Module({
  controllers: [GeoController],
  providers: [GeoService],
})
export class GeoModule {}
