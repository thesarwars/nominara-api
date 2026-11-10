import { Module } from "@nestjs/common";
import { GSC_CLIENT } from "../../lib/gsc/port.js";
import { HttpGscClient } from "../../lib/gsc/http-client.js";
import { GscCorrelationController } from "./gsc-correlation.controller.js";
import { GscCorrelationService } from "./gsc-correlation.service.js";
import { GscProjectController } from "./gsc-project.controller.js";
import { GscController } from "./gsc.controller.js";
import { GscService } from "./gsc.service.js";
import { IntegrationsController } from "./integrations.controller.js";
import { IntegrationsService } from "./integrations.service.js";

// STORY-022 - system-architecture.md section 5 module inventory. Registration only - no logic here (coding-standards.md section 1's
// module layout). STORY-115 adds the Search Console surface; it owns `gsc_connections` and READS `gsc_daily`, which the `gsc.sync` job writes.
// GSC_CLIENT is the port to Google: the real adapter is bound here, and every test replaces it with a fake.
@Module({
  controllers: [IntegrationsController, GscController, GscProjectController, GscCorrelationController],
  providers: [IntegrationsService, GscService, GscCorrelationService, { provide: GSC_CLIENT, useFactory: () => new HttpGscClient() }],
})
export class IntegrationsModule {}
