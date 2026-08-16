import { Module } from "@nestjs/common";
import { TerminusModule } from "@nestjs/terminus";
import { MIGRATIONS_DIR } from "../../db/migrate-runner.js";
import { HealthController } from "./health.controller.js";
import { HealthService, MIGRATIONS_DIR_TOKEN } from "./health.service.js";

@Module({
  imports: [TerminusModule],
  controllers: [HealthController],
  providers: [HealthService, { provide: MIGRATIONS_DIR_TOKEN, useValue: MIGRATIONS_DIR }],
})
export class HealthModule {}
