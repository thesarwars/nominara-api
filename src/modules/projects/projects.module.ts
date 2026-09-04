import { Module } from "@nestjs/common";
import { ProjectsController } from "./projects.controller.js";
import { ProjectsService } from "./projects.service.js";
import { QueueProducerModule } from "../../lib/queue/queue-producer.module.js";
import { EntitlementsModule } from "../entitlements/entitlements.module.js";
import { UrlGuard } from "../../lib/net/url-guard.service.js";

// STORY-022 — system-architecture.md §5 module inventory. Registration only —
// no logic here (coding-standards.md §1's module layout).
//
// STORY-043 adds the two collaborators POST /projects needs: the queue
// producer (to enqueue crawl.discover after commit) and the entitlement
// resolver (to read prompts_cap before the insert). EntitlementsModule
// already exports the resolver for EntitlementGuard's sake, so this imports
// it rather than constructing a second instance with its own cache.
@Module({
  imports: [QueueProducerModule, EntitlementsModule],
  controllers: [ProjectsController],
  providers: [ProjectsService, UrlGuard],
})
export class ProjectsModule {}
