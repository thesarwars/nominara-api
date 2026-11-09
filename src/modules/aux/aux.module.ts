import { Module } from "@nestjs/common";
import { AuxController } from "./aux.controller.js";
import { AuxService } from "./aux.service.js";

// STORY-022 — system-architecture.md §5 module inventory. Registration
// only — no logic here (coding-standards.md §1's module layout).
@Module({
  controllers: [AuxController],
  providers: [AuxService],
  // STORY-192: the alignment routes read a patch back through the service that owns the patch reader.
  exports: [AuxService],
})
export class AuxModule {}
