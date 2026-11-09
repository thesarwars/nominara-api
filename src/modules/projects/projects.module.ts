import { Module } from "@nestjs/common";
import { ProjectsController } from "./projects.controller.js";
import { ProjectsService } from "./projects.service.js";
import { ProjectEnginesController } from "./project-engines.controller.js";
import { ProjectBenchmarkController } from "./project-benchmark.controller.js";
import { ProjectBenchmarkService } from "./project-benchmark.service.js";
import { CompetitorsController } from "./competitors.controller.js";
import { ProjectFingerprintController } from "./project-fingerprint.controller.js";
import { ProjectFingerprintService } from "./project-fingerprint.service.js";
import { ProjectEnginesService } from "./project-engines.service.js";
import { CompetitorTrackingService } from "./competitor-tracking.service.js";
import { QueueProducerModule } from "../../lib/queue/queue-producer.module.js";
import { EntitlementsModule } from "../entitlements/entitlements.module.js";
import { UrlGuard } from "../../lib/net/url-guard.service.js";
import { DomainVerificationService } from "./domain-verification.service.js";
import { CHECK_DEPS } from "./domain-verification.service.js";
import { defaultCheckDeps } from "../../lib/verification/checkers.js";

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
  controllers: [
    ProjectsController,
    CompetitorsController,
    ProjectEnginesController,
    ProjectFingerprintController,
    ProjectBenchmarkController,
  ],
  providers: [
    ProjectsService,
    CompetitorTrackingService,
    ProjectEnginesService,
    ProjectFingerprintService,
    ProjectBenchmarkService,
    UrlGuard,
    DomainVerificationService,
    // A factory, so a test supplies its own resolver and fetcher and the
    // production one builds a Resolver we chose rather than reading whatever
    // is in the container's /etc/resolv.conf (STORY-048 AC4).
    { provide: CHECK_DEPS, useFactory: () => defaultCheckDeps() },
  ],
  exports: [ProjectsService],
})
export class ProjectsModule {}
