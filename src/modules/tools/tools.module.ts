import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module.js";
import { EntitlementsModule } from "../entitlements/entitlements.module.js";
import { ProjectsModule } from "../projects/projects.module.js";
import { UrlGuard } from "../../lib/net/url-guard.service.js";
import { AuxAuditToolService } from "./aux-audit.service.js";
import { CompareRunsService } from "./compare-runs.service.js";
import { CompetitorFinderService } from "./competitor-finder.service.js";
import { SchemaBuilderService } from "./schema-builder.service.js";
import { SchemaBuilderUrlService } from "./schema-builder-url.service.js";
import { ToolCatalogService } from "./tool-catalog.service.js";
import { ToolsController } from "./tools.controller.js";
import { QueueProducerModule } from "../../lib/queue/queue-producer.module.js";
import { ToolsService } from "./tools.service.js";
import { PromptResearchService } from "./prompt-research.service.js";
import { VisibilityScanService } from "./visibility-scan.service.js";

// STORY-022 - system-architecture.md section 5 module inventory. Registration only - no logic here (coding-standards.md section 1's module layout).
// STORY-078: the service is exported so each tool's own story starts and finishes its runs through it, and imports ProjectsService
// (one table, one owning service: conversion creates a project through the service that owns projects, never through its table).
@Module({
  imports: [AuditModule, EntitlementsModule, ProjectsModule, QueueProducerModule],
  controllers: [ToolsController],
  providers: [ToolsService, CompareRunsService, SchemaBuilderService, SchemaBuilderUrlService, VisibilityScanService, PromptResearchService, CompetitorFinderService, AuxAuditToolService, ToolCatalogService, UrlGuard],
  exports: [ToolsService],
})
export class ToolsModule {}
