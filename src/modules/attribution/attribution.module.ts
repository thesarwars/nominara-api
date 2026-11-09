import { Module } from "@nestjs/common";
import { AttributionConfigController } from "./attribution-config.controller.js";
import { AttributionConfigService } from "./attribution-config.service.js";
import { AttributionIngestController } from "./attribution-ingest.controller.js";
import { AttributionIngestService } from "./attribution-ingest.service.js";

// STORY-113 - system-architecture.md section 5 (`AttributionModule`): beacon configuration and `/ingest/attribution`. Registration only.
// It owns `attribution_configs` and `attribution_daily`; the per-URL rollup (STORY-114) lands here too.
@Module({
  controllers: [AttributionConfigController, AttributionIngestController],
  providers: [AttributionConfigService, AttributionIngestService],
  exports: [AttributionConfigService],
})
export class AttributionModule {}
