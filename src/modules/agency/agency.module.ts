import { Module } from "@nestjs/common";
import { AgencyController } from "./agency.controller.js";
import { AgencyService } from "./agency.service.js";
import { ShareTokensController } from "./share-tokens.controller.js";
import { ShareTokensService } from "./share-tokens.service.js";
import { StorageModule } from "../../lib/storage/storage.module.js";
import { ThemeAssetsController } from "./theme-assets.controller.js";
import { ThemeAssetsService } from "./theme-assets.service.js";
import { AuditModule } from "../audit/audit.module.js";

// STORY-022 — system-architecture.md §5 module inventory. Registration
// only — no logic here (coding-standards.md §1's module layout).
@Module({
  imports: [AuditModule, StorageModule],
  controllers: [AgencyController, ShareTokensController, ThemeAssetsController],
  providers: [AgencyService, ShareTokensService, ThemeAssetsService],
  exports: [ShareTokensService, AgencyService],
})
export class AgencyModule {}
