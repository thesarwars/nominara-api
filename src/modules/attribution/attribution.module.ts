import { Module } from "@nestjs/common";
import { AttributionController } from "./attribution.controller.js";
import { AttributionService } from "./attribution.service.js";
import { AttributionConfigController } from "./attribution-config.controller.js";
import { AttributionConfigService } from "./attribution-config.service.js";
import { AttributionIngestController } from "./attribution-ingest.controller.js";
import { AttributionIngestService } from "./attribution-ingest.service.js";

// STORY-113 - system-architecture.md section 5 (`AttributionModule`): beacon configuration and `/ingest/attribution`. Registration only.
// It owns `attribution_configs` and `attribution_daily`; the per-URL rollup READ (STORY-114, `GET /projects/{id}/attribution`) lands here too; the job that writes it is a queue handler.
@Module({
  controllers: [AttributionConfigController, AttributionController, AttributionIngestController],
  providers: [AttributionConfigService, AttributionIngestService, AttributionService],
  exports: [AttributionConfigService, AttributionService],
})
export class AttributionModule {}
